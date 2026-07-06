/* ═══════════════════════════════════════════════════════════════════════════
   LoveFlix Music — tri-provider connectors + playback abstraction.

   window.LoveFlixMusic = {
     connections,   // music_connections CRUD + Spotify OAuth / Apple MusicKit /
                    // YouTube instant-select flows
     createPlayer,  // LoveFlixPlayer factory → Spotify / Apple Music / YouTube adapter
     resolveTrack,  // cross-provider track matching (ISRC first, search fallback)
     sync,          // couple_music_state "listen together" engine
     PROVIDERS,
   }

   Track model (provider-agnostic — this is what playlists and shared state
   store; provider IDs are resolved at play time):
     { title, artist, isrc?, youtubeId?, artworkUrl?, duration? }

   LoveFlixPlayer interface (every adapter implements it):
     play(track) → {ok} | {ok:false, reason:'unavailable'|'quota'|'premium_required'|'auth'}
     pause(), resume(), seek(seconds), setVolume(0..1),
     next(), previous()            (delegate to the page's queue via opts hooks)
     getCurrentTrack(), getPosition(), getDuration(), isPlaying(),
     onStateChange(cb), searchTracks(q), destroy()

   Depends on window.LoveFlix (assets/loveflix.js) for Supabase auth/session.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const PROVIDERS = {
    spotify:     { id: 'spotify',     label: 'Spotify',     premium: true  },
    apple_music: { id: 'apple_music', label: 'Apple Music', premium: true  },
    youtube:     { id: 'youtube',     label: 'YouTube',     premium: false },
  };

  const SPOTIFY_SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';

  function lf() { return global.LoveFlix || {}; }

  async function freshToken() {
    try { if (lf().ensureFreshToken) await lf().ensureFreshToken(); } catch (_) {}
    return lf().getToken ? lf().getToken() : null;
  }

  async function sbFetch(pathAndQuery, opts = {}) {
    const token = await freshToken();
    if (!token) throw new Error('not_signed_in');
    const headers = {
      apikey: lf().SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    };
    const res = await fetch(lf().SUPABASE_URL + pathAndQuery, { ...opts, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('supabase ' + res.status + ' ' + text.slice(0, 200));
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  // ── PKCE helpers (Spotify Authorization Code + PKCE) ───────────────────────
  function b64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(digest));
  }

  // ── SDK loaders (lazy — only the active provider's SDK is loaded) ──────────
  // Every load is capped so a blocked CDN can never hang player init forever.
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + '_load_timeout')), ms)),
    ]);
  }

  let ytApiPromise = null;
  function loadYouTubeApi() {
    if (global.YT && global.YT.Player) return Promise.resolve();
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve) => {
      const prev = global.onYouTubeIframeAPIReady;
      global.onYouTubeIframeAPIReady = () => {
        if (prev) { try { prev(); } catch (_) {} }
        resolve();
      };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(s);
      }
    });
    return ytApiPromise;
  }

  let spotifySdkPromise = null;
  function loadSpotifySdk() {
    if (global.Spotify && global.Spotify.Player) return Promise.resolve();
    if (spotifySdkPromise) return spotifySdkPromise;
    spotifySdkPromise = new Promise((resolve) => {
      const prev = global.onSpotifyWebPlaybackSDKReady;
      global.onSpotifyWebPlaybackSDKReady = () => {
        if (prev) { try { prev(); } catch (_) {} }
        resolve();
      };
      if (!document.querySelector('script[src*="sdk.scdn.co/spotify-player"]')) {
        const s = document.createElement('script');
        s.src = 'https://sdk.scdn.co/spotify-player.js';
        document.head.appendChild(s);
      }
    });
    return spotifySdkPromise;
  }

  let musicKitPromise = null;
  function loadMusicKit() {
    if (global.MusicKit) return Promise.resolve();
    if (musicKitPromise) return musicKitPromise;
    musicKitPromise = new Promise((resolve) => {
      document.addEventListener('musickitloaded', () => resolve(), { once: true });
      if (!document.querySelector('script[src*="musickit.js"]')) {
        const s = document.createElement('script');
        s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
        s.async = true;
        document.head.appendChild(s);
      }
    });
    return musicKitPromise;
  }

  let appleConfigured = false;
  async function configuredMusicKit() {
    await withTimeout(loadMusicKit(), 15000, 'apple_music');
    if (!appleConfigured) {
      const cfg = await fetch('/api/music/apple-config').then(r => r.json()).catch(() => ({}));
      if (!cfg.developerToken) throw new Error('apple_not_configured');
      await global.MusicKit.configure({
        developerToken: cfg.developerToken,
        app: { name: 'LoveFlix Music', build: '1.0' },
      });
      appleConfigured = true;
    }
    return global.MusicKit.getInstance();
  }

  // ── Connections (Supabase music_connections) ───────────────────────────────
  const connections = {
    PROVIDERS,

    // The caller's active connection row, or null.
    async get() {
      const uid = lf().getUserId && lf().getUserId();
      if (!uid) return null;
      const rows = await sbFetch(`/rest/v1/music_connections?user_id=eq.${uid}&disconnected_at=is.null&select=*&limit=1`);
      return (rows && rows[0]) || null;
    },

    // Token-free view of the partner's provider (RPC — never exposes tokens).
    async getPartner() {
      try {
        const rows = await sbFetch('/rest/v1/rpc/get_partner_music_provider', { method: 'POST', body: '{}' });
        return (rows && rows[0]) || null;
      } catch (_) { return null; }
    },

    // Replace the active provider: soft-delete the old row (reconnect history)
    // and insert the new one. Returns the new row.
    async setActive(provider, fields = {}) {
      const uid = lf().getUserId && lf().getUserId();
      if (!uid) throw new Error('not_signed_in');
      if (!PROVIDERS[provider]) throw new Error('unknown provider: ' + provider);
      await sbFetch(`/rest/v1/music_connections?user_id=eq.${uid}&disconnected_at=is.null`, {
        method: 'PATCH',
        body: JSON.stringify({ disconnected_at: new Date().toISOString() }),
      });
      const rows = await sbFetch('/rest/v1/music_connections', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: uid, provider, connected_at: new Date().toISOString(), ...fields }),
      });
      return (rows && rows[0]) || null;
    },

    async disconnect() {
      const uid = lf().getUserId && lf().getUserId();
      if (!uid) return;
      await sbFetch(`/rest/v1/music_connections?user_id=eq.${uid}&disconnected_at=is.null`, {
        method: 'PATCH',
        body: JSON.stringify({ disconnected_at: new Date().toISOString() }),
      });
    },

    // YouTube is the free option: no account link, no tokens — just mark it.
    async selectYouTube() {
      return this.setActive('youtube');
    },

    // Spotify OAuth 2.0 Authorization Code + PKCE. Redirects away; the return
    // leg is handled by completeSpotifyAuth() on page load.
    async connectSpotify() {
      const cfg = await fetch('/api/music/spotify-config').then(r => r.json()).catch(() => ({}));
      if (!cfg.clientId) throw new Error('spotify_not_configured');
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
      const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const redirectUri = location.origin + location.pathname;
      sessionStorage.setItem('lf_spotify_verifier', verifier);
      sessionStorage.setItem('lf_spotify_state', state);
      sessionStorage.setItem('lf_spotify_redirect', redirectUri);
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
        scope: SPOTIFY_SCOPES,
        code_challenge_method: 'S256',
        code_challenge: await pkceChallenge(verifier),
      });
      location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
    },

    // Call on page load. Consumes ?code=&state= from a Spotify redirect;
    // returns {connection, isPremium} when a connection was just made, else null.
    async completeSpotifyAuth() {
      const qs = new URLSearchParams(location.search);
      const code = qs.get('code');
      const state = qs.get('state');
      const verifier = sessionStorage.getItem('lf_spotify_verifier');
      if (!code || !verifier) return null;
      if (state !== sessionStorage.getItem('lf_spotify_state')) return null;
      const redirectUri = sessionStorage.getItem('lf_spotify_redirect') || (location.origin + location.pathname);
      sessionStorage.removeItem('lf_spotify_verifier');
      sessionStorage.removeItem('lf_spotify_state');
      sessionStorage.removeItem('lf_spotify_redirect');

      // Strip the OAuth params from the URL whatever happens next.
      try {
        qs.delete('code'); qs.delete('state');
        const rest = qs.toString();
        history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
      } catch (_) {}

      const token = await freshToken();
      const res = await fetch('/api/music/spotify/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) throw new Error('spotify_token_exchange_failed');

      // Who connected, and are they Premium? (Web Playback SDK needs Premium.)
      let me = {};
      try {
        me = await fetch('https://api.spotify.com/v1/me', {
          headers: { Authorization: 'Bearer ' + data.access_token },
        }).then(r => r.json());
      } catch (_) {}
      const isPremium = me.product === 'premium';

      const connection = await this.setActive('spotify', {
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        token_expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
        provider_account_email: me.email || null,
        provider_account_name: me.display_name || me.id || null,
        is_premium: isPremium,
      });
      return { connection, isPremium };
    },

    // Apple Music: MusicKit JS authorize() → store the Music User Token.
    async connectAppleMusic() {
      const music = await configuredMusicKit();
      const userToken = await music.authorize(); // Apple ID popup
      if (!userToken) throw new Error('apple_authorize_cancelled');
      const connection = await this.setActive('apple_music', {
        music_user_token: userToken,
        provider_account_name: 'Apple Music account',
        // A subscription can't be checked directly here; playback errors
        // surface it and the adapter reports premium_required.
        is_premium: null,
      });
      return { connection };
    },

    // Returns a currently-valid Spotify access token for the given connection
    // row, refreshing (and persisting the refresh) when close to expiry.
    async freshSpotifyToken(conn) {
      if (!conn) return null;
      const expMs = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;
      if (conn.access_token && expMs - Date.now() > 60 * 1000) return conn.access_token;
      if (!conn.refresh_token) return conn.access_token || null;
      const token = await freshToken();
      const res = await fetch('/api/music/spotify/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: conn.refresh_token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) return null;
      conn.access_token = data.access_token;
      if (data.refresh_token) conn.refresh_token = data.refresh_token;
      conn.token_expires_at = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
      try {
        await sbFetch(`/rest/v1/music_connections?id=eq.${conn.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            access_token: conn.access_token,
            refresh_token: conn.refresh_token,
            token_expires_at: conn.token_expires_at,
          }),
        });
      } catch (_) {}
      return conn.access_token;
    },
  };

  // ── Cross-provider track matching ───────────────────────────────────────────
  // Spotify/Apple Music → ISRC. YouTube has no reliable ISRC metadata → search
  // "{artist} {title} official audio" and prefer official/Topic channels.
  // Returns {ok:true, ref} or {ok:false, reason:'unavailable'|'quota'|'auth'}.
  async function resolveTrack(provider, track, ctx = {}) {
    try {
      if (provider === 'youtube') return await resolveYouTube(track);
      if (provider === 'spotify') return await resolveSpotify(track, ctx);
      if (provider === 'apple_music') return await resolveApple(track, ctx);
    } catch (_) {}
    return { ok: false, reason: 'unavailable' };
  }

  async function resolveYouTube(track) {
    if (track.youtubeId) {
      return { ok: true, ref: { provider: 'youtube', videoId: track.youtubeId, duration: track.duration || null } };
    }
    const q = `${track.artist || ''} ${track.title || ''} official audio`.trim();
    if (!q) return { ok: false, reason: 'unavailable' };
    const data = await fetch('/api/music/yt-match?q=' + encodeURIComponent(q)).then(r => r.json()).catch(() => ({}));
    if (data.quota_exceeded) return { ok: false, reason: 'quota' };
    if (!data.videoId || data.confident === false) return { ok: false, reason: 'unavailable' };
    return { ok: true, ref: { provider: 'youtube', videoId: data.videoId, duration: data.duration || null } };
  }

  async function resolveSpotify(track, ctx) {
    const token = ctx.getAccessToken ? await ctx.getAccessToken() : null;
    if (!token) return { ok: false, reason: 'auth' };
    const tryQuery = async (q) => {
      const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('auth'), { auth: true });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return (data.tracks && data.tracks.items && data.tracks.items[0]) || null;
    };
    try {
      let item = null;
      if (track.isrc) item = await tryQuery('isrc:' + track.isrc);
      if (!item && track.title) {
        item = await tryQuery(`track:"${track.title}" artist:"${track.artist || ''}"`);
      }
      if (!item) return { ok: false, reason: 'unavailable' };
      return {
        ok: true,
        ref: {
          provider: 'spotify',
          uri: item.uri,
          id: item.id,
          isrc: (item.external_ids && item.external_ids.isrc) || track.isrc || null,
          duration: item.duration_ms ? Math.round(item.duration_ms / 1000) : null,
          artworkUrl: (item.album && item.album.images && item.album.images[0] && item.album.images[0].url) || null,
        },
      };
    } catch (e) {
      return { ok: false, reason: e.auth ? 'auth' : 'unavailable' };
    }
  }

  async function resolveApple(track, ctx) {
    const music = ctx.music || await configuredMusicKit();
    const storefront = music.storefrontId || 'us';
    const pick = (songs) => (songs && songs[0]) || null;
    let song = null;
    if (track.isrc) {
      try {
        const resp = await music.api.music(`/v1/catalog/${storefront}/songs`, { 'filter[isrc]': track.isrc });
        song = pick(resp && resp.data && resp.data.data);
      } catch (_) {}
    }
    if (!song && track.title) {
      try {
        const term = `${track.artist || ''} ${track.title}`.trim();
        const resp = await music.api.music(`/v1/catalog/${storefront}/search`, { term, types: 'songs', limit: 1 });
        song = pick(resp && resp.data && resp.data.results && resp.data.results.songs && resp.data.results.songs.data);
      } catch (_) {}
    }
    if (!song) return { ok: false, reason: 'unavailable' };
    const attrs = song.attributes || {};
    return {
      ok: true,
      ref: {
        provider: 'apple_music',
        id: song.id,
        isrc: attrs.isrc || track.isrc || null,
        duration: attrs.durationInMillis ? Math.round(attrs.durationInMillis / 1000) : null,
        artworkUrl: attrs.artwork && attrs.artwork.url ? attrs.artwork.url.replace('{w}', '600').replace('{h}', '600') : null,
      },
    };
  }

  // ── LoveFlixPlayer base ─────────────────────────────────────────────────────
  class BasePlayer {
    constructor(opts = {}) {
      this.opts = opts;
      this._listeners = [];
      this._track = null;
      this._playing = false;
      this._position = 0;
      this._duration = 0;
      this._destroyed = false;
    }
    onStateChange(cb) { this._listeners.push(cb); return () => { this._listeners = this._listeners.filter(x => x !== cb); }; }
    _emit(evt) {
      if (this._destroyed) return;
      for (const cb of this._listeners) { try { cb(evt); } catch (_) {} }
    }
    getCurrentTrack() { return this._track; }
    getPosition() { return this._position; }
    getDuration() { return this._duration; }
    isPlaying() { return this._playing; }
    // Queue order lives in the page — next/previous delegate to it so every
    // adapter shares one queue implementation.
    next() { if (this.opts.onRequestNext) this.opts.onRequestNext(); }
    previous() { if (this.opts.onRequestPrevious) this.opts.onRequestPrevious(); }
    async searchTracks() { return []; }
    destroy() { this._destroyed = true; this._listeners = []; }
  }

  // ── YouTubePlayerAdapter — IFrame Player API, VIDEO VISIBLE ────────────────
  // The free-tier option: the actual YouTube player renders in the now-playing
  // UI (never hidden), pre/mid-roll ads play normally, per YouTube's ToS.
  class YouTubePlayerAdapter extends BasePlayer {
    constructor(opts) {
      super(opts);
      this.provider = 'youtube';
      this._yt = null;
      this._pollTimer = null;
    }

    async init() {
      await withTimeout(loadYouTubeApi(), 15000, 'youtube');
      if (this._destroyed) return this;
      await new Promise((resolve) => {
        this._yt = new global.YT.Player(this.opts.youtubeElementId, {
          height: '100%', width: '100%',
          playerVars: {
            autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3,
            modestbranding: 1, rel: 0, playsinline: 1,
          },
          events: {
            onReady: () => resolve(),
            onStateChange: (e) => this._onYtState(e),
            onError: () => this._emit({ type: 'error', code: 'playback', message: 'YouTube playback error' }),
          },
        });
      });
      this._emit({ type: 'ready' });
      return this;
    }

    _onYtState(e) {
      const S = global.YT.PlayerState;
      if (e.data === S.PLAYING) { this._playing = true; this._startPoll(); this._emit({ type: 'playing' }); }
      if (e.data === S.PAUSED) { this._playing = false; this._stopPoll(); this._emit({ type: 'paused' }); }
      if (e.data === S.ENDED) { this._playing = false; this._stopPoll(); this._emit({ type: 'ended' }); }
    }

    _startPoll() {
      this._stopPoll();
      this._pollTimer = setInterval(() => {
        try {
          this._position = this._yt.getCurrentTime() || 0;
          const d = this._yt.getDuration() || 0;
          if (d > 0) this._duration = d;
          this._emit({ type: 'position', position: this._position, duration: this._duration });
        } catch (_) {}
      }, 500);
    }
    _stopPoll() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } }

    async play(track) {
      const match = await resolveYouTube(track);
      if (!match.ok) {
        this._emit({ type: 'unavailable', track, reason: match.reason });
        return { ok: false, reason: match.reason };
      }
      this._track = { ...track, youtubeId: match.ref.videoId };
      this._position = 0;
      if (match.ref.duration) this._duration = match.ref.duration;
      this._yt.loadVideoById({ videoId: match.ref.videoId, startSeconds: 0 });
      try { this._yt.playVideo(); } catch (_) {}
      // Autoplay policies start the iframe muted until a user gesture; unmute
      // as soon as playback is running.
      setTimeout(() => { try { if (this._yt.isMuted()) this._yt.unMute(); } catch (_) {} }, 200);
      this._emit({ type: 'trackchange', track: this._track });
      return { ok: true };
    }

    pause() { try { this._yt.pauseVideo(); } catch (_) {} }
    resume() {
      try {
        this._yt.playVideo();
        setTimeout(() => { try { if (this._yt.isMuted()) this._yt.unMute(); } catch (_) {} }, 200);
      } catch (_) {}
    }
    seek(seconds) { try { this._yt.seekTo(seconds, true); this._position = seconds; } catch (_) {} }
    setVolume(v) { try { this._yt.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100)); } catch (_) {} }

    async searchTracks(q) {
      const data = await fetch('/api/music/search?q=' + encodeURIComponent(q)).then(r => r.json()).catch(() => ({}));
      if (data.quota_exceeded) { this._emit({ type: 'error', code: 'quota', message: 'YouTube search limit reached' }); return []; }
      return (data.tracks || []).map(t => ({
        title: t.title, artist: t.artist || t.channel, youtubeId: t.videoId,
        artworkUrl: t.artwork_url || null, duration: t.duration || null,
      }));
    }

    destroy() {
      this._stopPoll();
      try { this._yt && this._yt.destroy(); } catch (_) {}
      super.destroy();
    }
  }

  // ── SpotifyPlayerAdapter — Web Playback SDK (Premium required) ─────────────
  class SpotifyPlayerAdapter extends BasePlayer {
    constructor(opts) {
      super(opts);
      this.provider = 'spotify';
      this._sdk = null;
      this._deviceId = null;
      this._pollTimer = null;
      this._endedGuard = { lastPos: 0, lastDur: 0 };
    }

    async _token() {
      const conn = this.opts.getConnection ? this.opts.getConnection() : null;
      return connections.freshSpotifyToken(conn);
    }

    async init() {
      await withTimeout(loadSpotifySdk(), 15000, 'spotify');
      if (this._destroyed) return this;
      const self = this;
      this._sdk = new global.Spotify.Player({
        name: 'LoveFlix Music',
        volume: this.opts.volume != null ? this.opts.volume : 0.72,
        getOAuthToken: (cb) => { self._token().then(t => cb(t || '')); },
      });
      this._sdk.addListener('account_error', () => {
        // Non-Premium account: the SDK cannot stream. Surface it, don't break.
        this._emit({ type: 'error', code: 'premium_required', message: 'Spotify Premium is required for playback' });
      });
      this._sdk.addListener('authentication_error', () => this._emit({ type: 'error', code: 'auth', message: 'Spotify session expired — reconnect in Music Connectors' }));
      this._sdk.addListener('initialization_error', () => this._emit({ type: 'error', code: 'playback', message: 'Spotify player failed to start' }));
      this._sdk.addListener('playback_error', () => this._emit({ type: 'error', code: 'playback', message: 'Spotify playback error' }));
      this._sdk.addListener('player_state_changed', (state) => this._onSdkState(state));
      const ready = new Promise((resolve) => {
        this._sdk.addListener('ready', ({ device_id }) => { this._deviceId = device_id; resolve(); });
      });
      const connected = await this._sdk.connect();
      if (!connected) { this._emit({ type: 'error', code: 'playback', message: 'Could not connect Spotify player' }); return this; }
      await Promise.race([ready, new Promise(r => setTimeout(r, 8000))]);
      this._startPoll();
      this._emit({ type: 'ready' });
      return this;
    }

    _onSdkState(state) {
      if (!state) return;
      const wasPlaying = this._playing;
      this._playing = !state.paused;
      this._position = (state.position || 0) / 1000;
      this._duration = (state.duration || 0) / 1000;
      // The SDK has no explicit 'ended' event: it rewinds to 0 and pauses.
      const g = this._endedGuard;
      if (state.paused && state.position === 0 && wasPlaying && g.lastDur > 0 && g.lastPos > g.lastDur - 3) {
        this._emit({ type: 'ended' });
      } else if (this._playing && !wasPlaying) {
        this._emit({ type: 'playing' });
      } else if (!this._playing && wasPlaying) {
        this._emit({ type: 'paused' });
      }
      g.lastPos = this._position; g.lastDur = this._duration;
    }

    _startPoll() {
      this._stopPoll();
      this._pollTimer = setInterval(async () => {
        try {
          const state = await this._sdk.getCurrentState();
          if (state && this._playing) {
            this._position = (state.position || 0) / 1000;
            this._duration = (state.duration || 0) / 1000;
            this._endedGuard.lastPos = this._position;
            this._endedGuard.lastDur = this._duration;
            this._emit({ type: 'position', position: this._position, duration: this._duration });
          }
        } catch (_) {}
      }, 500);
    }
    _stopPoll() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } }

    async play(track) {
      const token = await this._token();
      if (!token) return { ok: false, reason: 'auth' };
      const match = await resolveSpotify(track, { getAccessToken: () => token });
      if (!match.ok) {
        this._emit({ type: 'unavailable', track, reason: match.reason });
        return { ok: false, reason: match.reason };
      }
      if (!this._deviceId) return { ok: false, reason: 'playback' };
      const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(this._deviceId)}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ uris: [match.ref.uri] }),
      });
      if (res.status === 403) {
        this._emit({ type: 'error', code: 'premium_required', message: 'Spotify Premium is required for playback' });
        return { ok: false, reason: 'premium_required' };
      }
      if (!res.ok && res.status !== 204) return { ok: false, reason: 'playback' };
      this._track = { ...track, isrc: match.ref.isrc || track.isrc, artworkUrl: track.artworkUrl || match.ref.artworkUrl };
      this._position = 0;
      if (match.ref.duration) this._duration = match.ref.duration;
      this._emit({ type: 'trackchange', track: this._track });
      return { ok: true };
    }

    pause() { try { this._sdk.pause(); } catch (_) {} }
    resume() { try { this._sdk.resume(); } catch (_) {} }
    seek(seconds) { try { this._sdk.seek(Math.round(seconds * 1000)); this._position = seconds; } catch (_) {} }
    setVolume(v) { try { this._sdk.setVolume(Math.max(0, Math.min(1, v))); } catch (_) {} }

    async searchTracks(q) {
      const token = await this._token();
      if (!token) return [];
      const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=12&q=${encodeURIComponent(q)}`, {
        headers: { Authorization: 'Bearer ' + token },
      }).catch(() => null);
      if (!res || !res.ok) return [];
      const data = await res.json().catch(() => ({}));
      return ((data.tracks && data.tracks.items) || []).map(t => ({
        title: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        isrc: (t.external_ids && t.external_ids.isrc) || null,
        artworkUrl: (t.album && t.album.images && t.album.images[0] && t.album.images[0].url) || null,
        duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
      }));
    }

    destroy() {
      this._stopPoll();
      try { this._sdk && this._sdk.disconnect(); } catch (_) {}
      super.destroy();
    }
  }

  // ── AppleMusicPlayerAdapter — MusicKit JS (subscription required) ──────────
  class AppleMusicPlayerAdapter extends BasePlayer {
    constructor(opts) {
      super(opts);
      this.provider = 'apple_music';
      this._music = null;
      this._boundState = null;
      this._boundTime = null;
    }

    async init() {
      this._music = await configuredMusicKit();
      if (this._destroyed) return this;
      const conn = this.opts.getConnection ? this.opts.getConnection() : null;
      if (conn && conn.music_user_token && !this._music.isAuthorized) {
        try { this._music.musicUserToken = conn.music_user_token; } catch (_) {}
      }
      const S = global.MusicKit.PlaybackStates;
      this._boundState = () => {
        const st = this._music.playbackState;
        if (st === S.playing) { this._playing = true; this._emit({ type: 'playing' }); }
        else if (st === S.paused) { this._playing = false; this._emit({ type: 'paused' }); }
        else if (st === S.ended || st === S.completed) { this._playing = false; this._emit({ type: 'ended' }); }
      };
      this._boundTime = () => {
        this._position = this._music.currentPlaybackTime || 0;
        this._duration = this._music.currentPlaybackDuration || this._duration;
        this._emit({ type: 'position', position: this._position, duration: this._duration });
      };
      this._music.addEventListener('playbackStateDidChange', this._boundState);
      this._music.addEventListener('playbackTimeDidChange', this._boundTime);
      this._emit({ type: 'ready' });
      return this;
    }

    async play(track) {
      const match = await resolveApple(track, { music: this._music });
      if (!match.ok) {
        this._emit({ type: 'unavailable', track, reason: match.reason });
        return { ok: false, reason: match.reason };
      }
      try {
        await this._music.setQueue({ songs: [match.ref.id] });
        await this._music.play();
      } catch (e) {
        // Playback without an active Apple Music subscription throws here.
        this._emit({ type: 'error', code: 'premium_required', message: 'An Apple Music subscription is required for playback' });
        return { ok: false, reason: 'premium_required' };
      }
      this._track = { ...track, isrc: match.ref.isrc || track.isrc, artworkUrl: track.artworkUrl || match.ref.artworkUrl };
      this._position = 0;
      if (match.ref.duration) this._duration = match.ref.duration;
      this._emit({ type: 'trackchange', track: this._track });
      return { ok: true };
    }

    pause() { try { this._music.pause(); } catch (_) {} }
    resume() { try { this._music.play(); } catch (_) {} }
    seek(seconds) { try { this._music.seekToTime(seconds); this._position = seconds; } catch (_) {} }
    setVolume(v) { try { this._music.volume = Math.max(0, Math.min(1, v)); } catch (_) {} }

    async searchTracks(q) {
      try {
        const storefront = this._music.storefrontId || 'us';
        const resp = await this._music.api.music(`/v1/catalog/${storefront}/search`, { term: q, types: 'songs', limit: 12 });
        const songs = (resp && resp.data && resp.data.results && resp.data.results.songs && resp.data.results.songs.data) || [];
        return songs.map(s => {
          const a = s.attributes || {};
          return {
            title: a.name,
            artist: a.artistName,
            isrc: a.isrc || null,
            artworkUrl: a.artwork && a.artwork.url ? a.artwork.url.replace('{w}', '600').replace('{h}', '600') : null,
            duration: a.durationInMillis ? Math.round(a.durationInMillis / 1000) : null,
          };
        });
      } catch (_) { return []; }
    }

    destroy() {
      try {
        this._music.removeEventListener('playbackStateDidChange', this._boundState);
        this._music.removeEventListener('playbackTimeDidChange', this._boundTime);
        this._music.stop();
      } catch (_) {}
      super.destroy();
    }
  }

  // ── Factory ─────────────────────────────────────────────────────────────────
  async function createPlayer(provider, opts = {}) {
    let player;
    if (provider === 'spotify') player = new SpotifyPlayerAdapter(opts);
    else if (provider === 'apple_music') player = new AppleMusicPlayerAdapter(opts);
    else player = new YouTubePlayerAdapter(opts);
    if (opts.onState) player.onStateChange(opts.onState);
    await player.init();
    return player;
  }

  // ── Shared playback state ("listen together") ───────────────────────────────
  // Provider-agnostic: only title/artist/ISRC travel between partners; each
  // side resolves on its own provider. Polling keeps this dependency-free.
  const sync = {
    _timer: null,
    _lastSeen: null,

    async push(state) {
      const coupleId = lf().getCoupleId && lf().getCoupleId();
      const uid = lf().getUserId && lf().getUserId();
      if (!coupleId || !uid) return;
      try {
        await sbFetch('/rest/v1/couple_music_state', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({
            couple_id: coupleId,
            updated_by: uid,
            updated_at: new Date().toISOString(),
            ...state,
          }),
        });
      } catch (_) {}
    },

    // Poll for the partner's state; onRemote(row) fires only for rows written
    // by the partner that we haven't applied yet.
    start(onRemote, intervalMs = 5000) {
      this.stop();
      const tick = async () => {
        const coupleId = lf().getCoupleId && lf().getCoupleId();
        const uid = lf().getUserId && lf().getUserId();
        if (!coupleId || !uid) return;
        try {
          const rows = await sbFetch(`/rest/v1/couple_music_state?couple_id=eq.${coupleId}&select=*&limit=1`);
          const row = rows && rows[0];
          if (!row || row.updated_by === uid) return;
          if (row.updated_at === this._lastSeen) return;
          this._lastSeen = row.updated_at;
          onRemote(row);
        } catch (_) {}
      };
      this._timer = setInterval(tick, intervalMs);
      tick();
    },

    stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },
  };

  global.LoveFlixMusic = { PROVIDERS, connections, createPlayer, resolveTrack, sync };
})(window);
