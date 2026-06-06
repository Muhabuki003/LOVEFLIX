// LoveFlix shared client — Supabase auth + API helpers.
// Used by every page. Vanilla JS, no build step.
(function (global) {
  const SUPABASE_URL = 'https://jeblgjjutyzzdursjqnn.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplYmxnamp1dHl6emR1cnNqcW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMzY0NjgsImV4cCI6MjA5MzcxMjQ2OH0.X9YVrfLJ4JSIBdXVkpYegeZ5kEqJzkmzQ1P0d3tFoko';

  const TOKEN_KEY = 'loveflix_token';
  const REFRESH_KEY = 'loveflix_refresh_token';
  const USER_KEY = 'loveflix_user';
  const SETTINGS_KEY = 'loveflix_settings';
  // Mirror of settings written while unauthenticated (e.g. signup before email
  // confirm). Flushed to the server on the next successful sign-in.
  const PENDING_KEY = 'loveflix_pending_settings';
  // Client-side timestamp embedded inside the settings object. Used to resolve
  // local vs server conflicts on pull so a freshly-saved name is never
  // overwritten by stale server data.
  const TS_FIELD = '__updatedAt';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }
  function setSession({ access_token, refresh_token, user }) {
    if (access_token) localStorage.setItem(TOKEN_KEY, access_token);
    if (refresh_token) localStorage.setItem(REFRESH_KEY, refresh_token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    try { localStorage.removeItem('loveflix_couple_id'); } catch (_) {}
    try { localStorage.removeItem('loveflix_creator_id'); } catch (_) {}
    try { localStorage.removeItem('loveflix_role'); } catch (_) {}
    try { localStorage.removeItem(SETTINGS_KEY); } catch (_) {}
  }

  // Silently refresh the access token using the stored refresh token.
  // Returns true on success, false if there's nothing to refresh with.
  async function refreshSession() {
    const rt = localStorage.getItem(REFRESH_KEY);
    if (!rt) return false;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) { clearSession(); return false; }
      const data = await res.json();
      setSession(data);
      return true;
    } catch { return false; }
  }

  // Returns true if the stored access token is still valid (not expired).
  function isTokenFresh() {
    const token = getToken();
    if (!token) return false;
    try {
      const { exp } = JSON.parse(atob(token.split('.')[1]));
      // Treat as expired 60s early to avoid races
      return exp * 1000 > Date.now() + 60000;
    } catch { return false; }
  }

  // Ensures a fresh access token is in localStorage; refreshes if needed.
  // Call before any authenticated Supabase REST request.
  async function ensureFreshToken() {
    if (isTokenFresh()) return;
    await refreshSession();
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
  }

  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') || {}; }
    catch { return {}; }
  }
  function writeSettings(obj) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj || {})); } catch (_) {}
  }
  function writePending(obj) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(obj || {})); } catch (_) {}
  }
  function readPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); }
    catch { return null; }
  }
  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
  }
  function saveSettings(updates, options) {
    const opts = options || {};
    const merged = Object.assign(getSettings(), updates || {});
    merged[TS_FIELD] = Date.now();
    writeSettings(merged);
    // Always stash a pending copy too: if the user isn't authenticated yet
    // (e.g. mid-signup before email confirm) we still want these to land on
    // the server after the first sign-in.
    writePending(stripLargeFields(merged));
    if (opts.flush) {
      return flushPushSettings().then(() => merged);
    }
    schedulePushSettings();
    return merged;
  }
  function clearSettings() {
    localStorage.removeItem(SETTINGS_KEY);
    clearPending();
  }

  // ----- Cross-device sync for LoveFlix.getSettings -----
  // Photos are compressed to thumbnails at upload time (max 200px, JPEG 0.75)
  // so they are small enough to store in D1 and sync across all devices.
  const LARGE_FIELDS = [];
  function stripLargeFields(settings) {
    const out = {};
    for (const k of Object.keys(settings || {})) {
      if (LARGE_FIELDS.includes(k)) continue;
      out[k] = settings[k];
    }
    return out;
  }

  // Promise that resolves on the first completed pull (or its fallback). Pages
  // that need accurate names — profile selectors, settings, anywhere a name is
  // displayed — should `await LoveFlix.ensureSettingsReady()` before painting.
  let _settingsReady;
  let _settingsReadyResolve;
  function resetSettingsReady() {
    _settingsReady = new Promise(r => { _settingsReadyResolve = r; });
  }
  resetSettingsReady();
  function resolveSettingsReady(value) {
    if (_settingsReadyResolve) {
      _settingsReadyResolve(value);
      _settingsReadyResolve = null;
    }
  }
  function ensureSettingsReady() {
    return _settingsReady;
  }

  let _pushTimer = null;
  let _pushInFlight = null;
  function schedulePushSettings() {
    if (!getToken()) return; // unauthenticated → pending mirror only
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => { pushSettings().catch(() => {}); }, 400);
  }
  async function flushPushSettings() {
    clearTimeout(_pushTimer);
    return pushSettings();
  }
  async function pushSettings() {
    if (!getToken()) return; // pending mirror will flush on next sign-in
    await ensureFreshToken();
    if (!getToken()) return; // token invalid even after refresh
    if (_pushInFlight) {
      // Coalesce concurrent pushes; the in-flight one already reads the
      // latest local copy at send time.
      return _pushInFlight;
    }
    _pushInFlight = (async () => {
      try {
        await api('/api/settings', {
          method: 'PUT',
          body: { settings: stripLargeFields(getSettings()) },
        });
        clearPending();
      } catch (e) {
        // Keep pending so the next page load / sign-in retries automatically.
        console.warn('settings sync push failed', e && e.message);
        throw e;
      }
    })();
    try { await _pushInFlight; } finally { _pushInFlight = null; }
  }

  // Push any settings saved while unauthenticated. Called automatically after
  // signIn/signUp and before pullSettings.
  async function flushPendingIfAny() {
    if (!getToken()) return;
    const pending = readPending();
    if (!pending || typeof pending !== 'object') return;
    // Merge pending into local so subsequent reads see them immediately.
    const local = getSettings();
    const merged = Object.assign({}, local, pending);
    // Keep whichever timestamp is newer.
    const ts = Math.max(local[TS_FIELD] || 0, pending[TS_FIELD] || 0, Date.now());
    merged[TS_FIELD] = ts;
    writeSettings(merged);
    try {
      await api('/api/settings', { method: 'PUT', body: { settings: stripLargeFields(merged) } });
      clearPending();
    } catch (e) {
      console.warn('pending settings flush failed', e && e.message);
    }
  }

  // Decide whether a settings object contains anything user-meaningful (i.e.
  // anything beyond the bookkeeping timestamp). Pure-timestamp objects count
  // as empty for sync-direction decisions.
  function hasMeaningfulFields(obj) {
    if (!obj || typeof obj !== 'object') return false;
    for (const k of Object.keys(obj)) {
      if (k === TS_FIELD) continue;
      if (obj[k] !== '' && obj[k] != null) return true;
    }
    return false;
  }

  async function pullSettings() {
    try {
      await flushPendingIfAny();
      const data = await api('/api/settings');
      const serverSettings = (data && data.settings && typeof data.settings === 'object')
        ? data.settings : null;
      const local = getSettings();
      const localTs = local[TS_FIELD] || 0;
      const serverTs = serverSettings && serverSettings[TS_FIELD]
        ? serverSettings[TS_FIELD]
        : ((data && data.updated_at) || 0) * 1000;

      let next;
      const serverHas = hasMeaningfulFields(serverSettings);
      const localHas = hasMeaningfulFields(local);
      if (!serverHas) {
        // Nothing meaningful on the server yet — keep local, and if we're
        // authenticated and have anything worth syncing, force-push it now
        // (and KEEP the pending copy until the server confirms it landed, so
        // future page loads retry on their own).
        next = local;
        if (getToken() && localHas) {
          writePending(stripLargeFields(local));
          flushPushSettings().catch(() => {});
        }
      } else if (localTs && localTs > serverTs && localHas) {
        // Local has unsaved/newer changes (e.g. user edited a name and we
        // got here before the debounced push fired). Keep local and push.
        next = local;
        if (getToken()) flushPushSettings().catch(() => {});
      } else {
        // Server is authoritative. Adopt it but keep local-only fields
        // (photos) that we never push.
        next = Object.assign({}, serverSettings);
        for (const k of LARGE_FIELDS) if (local[k]) next[k] = local[k];
        writeSettings(next);
      }
      resolveSettingsReady(next);
      return next;
    } catch (e) {
      console.warn('settings sync pull failed', e && e.message);
    }
    const fallback = getSettings();
    resolveSettingsReady(fallback);
    return fallback;
  }

  // Active profile derived from the logged-in user's couple_members role
  // (cached by cacheCoupleId). Falls back to 'admin' so admin pages work
  // correctly when the cache hasn't been populated yet.
  function getActiveProfile() {
    const settings = getSettings();
    const adminName = settings.adminName || 'You';
    const partnerName = settings.partnerName || 'My Love';
    const role = (function() { try { return localStorage.getItem('loveflix_role') || 'admin'; } catch (_) { return 'admin'; } })();
    const isPartner = role === 'partner';
    return {
      role: isPartner ? 'her' : 'his',
      dbRole: role,
      name: isPartner ? partnerName : adminName,
      photo: isPartner ? (settings.partnerPhoto || '') : (settings.adminPhoto || ''),
      initial: ((isPartner ? partnerName : adminName)[0] || '?').toUpperCase(),
    };
  }

  // Paint the top-right viewer avatar (home/browse) with the active profile.
  // Re-paints automatically once settings finish syncing from the server.
  function paintNavAvatar(el) {
    if (!el) return;
    const apply = () => {
      const p = getActiveProfile();
      el.textContent = p.initial;
      if (p.photo && /^https?:\/\//i.test(p.photo)) {
        // Use the DOM style API directly so the browser never interprets the URL
        // as CSS syntax — no CSS injection possible through this path.
        el.style.backgroundImage = `url(${JSON.stringify(p.photo)})`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.style.color = 'transparent';
      } else {
        el.style.background = '';
        el.style.backgroundImage = '';
        el.style.color = '';
      }
    };
    apply();
    ensureSettingsReady().then(apply).catch(() => {});
    window.addEventListener('loveflix:settings-changed', apply);
  }

  function track(event, props) {
    try { window.LoveFlixAnalytics && window.LoveFlixAnalytics.capture(event, props); } catch (_) {}
  }
  function identify(user) {
    if (!user || !user.id) return;
    try {
      window.LoveFlixAnalytics && window.LoveFlixAnalytics.identify(user.id, {
        email: user.email,
        created_at: user.created_at,
      });
    } catch (_) {}
  }

  async function signIn(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign-in failed');
    setSession(data);
    identify(data.user);
    track('user_signed_in', { method: 'email' });
    // Pull/merge settings before redirecting so the next page sees real names.
    resetSettingsReady();
    try { await pullSettings(); } catch (_) {}
    cacheCoupleId().catch(() => {});
    return data;
  }

  async function signUp(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign-up failed');
    if (data.access_token) {
      setSession(data);
      identify(data.user);
      // Flush anything entered before signup completed.
      try { await flushPendingIfAny(); } catch (_) {}
      cacheCoupleId().catch(() => {});
    }
    track('user_signed_up', {
      method: 'email',
      // Supabase email-confirm flows return no access_token until confirmed.
      confirmed: !!data.access_token,
    });
    return data;
  }

  // Redirect the browser to Supabase's OAuth authorize endpoint for a social
  // provider ('google', 'apple', ...). Supabase runs the provider handshake and
  // redirects back to redirectTo with the session tokens in the URL hash, which
  // handleOAuthRedirect() picks up on the next page load. This is the implicit
  // (client-only) flow — no server callback route needed.
  function signInWithOAuth(provider, options) {
    const opts = options || {};
    // Default back to the page that initiated the sign-in (the login screen).
    const redirectTo = opts.redirectTo || (location.origin + location.pathname);
    const params = new URLSearchParams({ provider, redirect_to: redirectTo });
    track('user_oauth_started', { provider });
    location.href = `${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`;
  }

  // Detect and consume the OAuth tokens Supabase appends to the URL hash after a
  // social sign-in redirect (#access_token=...&refresh_token=...). On success,
  // stores the session and returns { access_token, refresh_token, user }.
  // Returns null when there's no OAuth payload in the URL. Throws if the
  // provider returned an error (e.g. the user cancelled).
  async function handleOAuthRedirect() {
    const hash = location.hash || '';
    if (!hash || (hash.indexOf('access_token') === -1 && hash.indexOf('error') === -1)) {
      return null;
    }
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const err = params.get('error_description') || params.get('error');
    // Strip the hash immediately so tokens never linger in the URL or history.
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
    if (err) throw new Error(decodeURIComponent(err.replace(/\+/g, ' ')));

    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token) return null;

    setSession({ access_token, refresh_token });

    // The implicit flow returns tokens but not the user object — fetch it so
    // identify() and couple caching have the real profile to work with.
    let user = null;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
      });
      if (res.ok) { user = await res.json(); setSession({ user }); }
    } catch (_) {}

    identify(user);
    track('user_signed_in', { method: 'oauth' });
    // Pull/merge settings before redirecting so the next page sees real names.
    resetSettingsReady();
    try { await flushPendingIfAny(); } catch (_) {}
    try { await pullSettings(); } catch (_) {}
    cacheCoupleId().catch(() => {});
    return { access_token, refresh_token, user };
  }

  function signOut() {
    track('user_signed_out');
    try { window.LoveFlixAnalytics && window.LoveFlixAnalytics.reset(); } catch (_) {}
    clearSession();
    location.href = 'loveflix_login_screen.html';
  }

  // Block protected pages until a token exists.
  function requireAuth() {
    if (!getToken()) {
      location.replace('loveflix_login_screen.html');
      return false;
    }
    startPresence();
    startMsgNotifications();
    return true;
  }

  // Broadcast presence so partner sees us as online on any page.
  // Upserts couple_presence every 60 s and on tab focus.
  let _presenceTimer = null;
  function startPresence() {
    if (_presenceTimer) return; // already running
    async function beat() {
      const token    = getToken();
      const coupleId = getCoupleId();
      const userId   = getUserId();
      if (!token || !coupleId || !userId) return;
      try {
        await fetch(
          `${SUPABASE_URL}/rest/v1/couple_presence`,
          {
            method: 'POST',
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify({ user_id: userId, couple_id: coupleId, last_seen: new Date().toISOString() }),
          }
        );
      } catch (_) {}
    }
    beat();
    _presenceTimer = setInterval(beat, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') beat();
    });
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const token = getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    // Forward the couple creator's id so the worker resolves the right tenant
    // when the logged-in user is the partner rather than the admin/creator.
    const creatorId = getCreatorId();
    if (creatorId) headers['x-tenant-id'] = creatorId;
    if (opts.body && !(opts.body instanceof FormData) && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)
        ? JSON.stringify(opts.body)
        : opts.body,
    });

    if (res.status === 401) {
      clearSession();
      location.replace('loveflix_login_screen.html');
      throw new Error('unauthorized');
    }

    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  // Direct PUT to R2 with progress.
  function putWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);
      const token = getToken();
      if (token && new URL(url, location.href).origin === location.origin) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && typeof onProgress === 'function') {
          onProgress(e.loaded / e.total, e.loaded, e.total);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`));
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => reject(new Error('Upload aborted'));
      xhr.send(file);
    });
  }

  // Apply the brand accent color from settings by overriding --brand-accent and
  // --red CSS custom properties. All pages reference var(--red) for the logo
  // and buttons, so overriding it here updates every styled element site-wide
  // without requiring per-page CSS changes.
  function applyBrandColor(settings) {
    const s = settings || getSettings();
    const hex = (s && (s.accentColor || s.brand_accent_color)) || '#e50914';
    // Validate hex so bad data can't inject CSS
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;

    // CSS variable approach — covers all elements already using var(--red) / var(--brand-accent)
    try {
      document.documentElement.style.setProperty('--brand-accent', hex);
      document.documentElement.style.setProperty('--red', hex);
      // Individual RGB channels let stylesheets build their own rgba() without JS injection
      document.documentElement.style.setProperty('--brand-r', String(parseInt(hex.slice(1,3),16)));
      document.documentElement.style.setProperty('--brand-g', String(parseInt(hex.slice(3,5),16)));
      document.documentElement.style.setProperty('--brand-b', String(parseInt(hex.slice(5,7),16)));
    } catch (_) {}

    // Parse to RGB components so we can reconstruct rgba() values
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const rgba = (a) => `rgba(${r},${g},${b},${a})`;

    // Inject / update a <style> tag to override every hardcoded #e50914 and
    // rgba(229,9,20,...) across all pages without requiring per-file edits.
    // Uses !important so it wins over inline styles too.
    try {
      let style = document.getElementById('lf-brand-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'lf-brand-style';
        document.head.appendChild(style);
      }
      style.textContent = [
        // CSS variables (belt + suspenders — inline JS setProperty above already does this)
        `:root{--brand-accent:${hex}!important;--red:${hex}!important;}`,
        // Logo text — login, join, profile selector, waitlist, etc.
        `.nf-logo{color:${hex}!important;}`,
        // Injected nav component (loveflix-nav.js uses .lf-nf-logo, not .nf-logo)
        `.lf-nf-logo{color:${hex}!important;}`,
        // Sidebar active highlight (rgba hardcoded in every admin page)
        `.side-link.active{background:${rgba(0.08)}!important;border-left-color:${hex}!important;}`,
        `.side-link.active.bottom{border-left-color:${hex}!important;}`,
        // Primary action buttons (hardcoded on login/join/checkout)
        `.btn-primary,.btn-join,.btn-enter{background:${hex}!important;}`,
        // Hero eyebrow pill (home.html)
        `.hero-eyebrow{color:${hex}!important;background:${rgba(0.1)}!important;border-color:${rgba(0.3)}!important;}`,
        `.hero-eyebrow::before{color:${hex}!important;border-color:${hex}!important;}`,
        // Hero tag badge (home.html)
        `.hero-tag{background:${rgba(0.18)}!important;border-color:${rgba(0.4)}!important;}`,
        // Card watch-progress bar (home.html)
        `.card-progress::after{background:${hex}!important;}`,
        // Admin dashboard stat accent bar
        `.stat::before{background:${hex}!important;}`,
        `.stat:nth-child(1){--accent:${hex}!important;}`,
        // Storage usage fill bar (inline style — !important beats it)
        `#storageFill{background:${hex}!important;}`,
        // Admin love-note card
        `.love-note{background:linear-gradient(135deg,${rgba(0.15)},rgba(168,85,247,0.1))!important;border-color:${rgba(0.3)}!important;}`,
        // Quick-action icon (covers inline --qbg/--qfg custom props too)
        `.quick-icon{--qbg:${rgba(0.15)}!important;--qfg:${hex}!important;color:${hex}!important;}`,
        // Preview logo shadow (admin_settings.html)
        `.preview-frame .lf{color:${hex}!important;text-shadow:0 0 30px ${rgba(0.5)}!important;}`,
        // Profile selector pin dots
        `.pin-dot.filled{background:${hex}!important;border-color:${hex}!important;}`,
        // Checkbox/toggle accent color
        `input[type="checkbox"]{accent-color:${hex}!important;}`,
        // Toggle track (admin_settings custom toggle)
        `.toggle input:checked~.toggle-track{background:${hex}!important;}`,
        // Input focus ring
        `.field input:focus,.field textarea:focus,.field select:focus{border-color:${hex}!important;}`,
        // Waitlist/landing glow radials (best-effort via ::before on known elements)
        `.waitlist-glow,.hero-glow{background:${rgba(0.2)}!important;}`,
        // Plan card selected state (onboarding)
        `.plan-card.selected{border-color:${hex}!important;background:${rgba(0.06)}!important;}`,
        // Heart icon in browse/search results (hardcoded fill)
        `svg path[fill="#e50914"]{fill:${hex}!important;}`,
        // Music page — sidebar active item
        `.side-item.active{background:${rgba(0.12)}!important;color:#fff!important;}`,
        `.side-item.active::before{background:${hex}!important;}`,
        // Music page — playlist row active
        `.playlist-row.active{background:${rgba(0.12)}!important;color:#fff!important;}`,
        // Music page — track save button hover
        `.track-save:hover{color:${hex}!important;background:${rgba(0.1)}!important;}`,
        // Music page — queue item currently playing
        `.queue-item.current{background:${rgba(0.1)}!important;}`,
        // Music page — mini-player fav button active
        `.m-fs-fav.active{color:${hex}!important;background:${rgba(0.16)}!important;}`,
        // Music page — album art gradient
        `.art-5{background:linear-gradient(135deg,${hex} 0%,#5a0410 100%)!important;}`,
        // Music page — hero play button and glow
        `.hero-play{background:${hex}!important;box-shadow:0 6px 14px ${rgba(0.45)}!important;}`,
        `.hero-play:hover{box-shadow:0 14px 38px ${rgba(0.6)}!important;}`,
        // Music page — currently playing track row
        `.track-row.playing{background:${rgba(0.08)}!important;}`,
        // Music page — remove from queue hover
        `.queue-remove:hover{background:${rgba(0.18)}!important;}`,
        // Home page — music card CTA gradient
        `.music-card--cta{background:linear-gradient(135deg,${hex} 0%,#8f1d4a 100%)!important;}`,
        `.music-card--cta:hover{background:linear-gradient(135deg,${hex} 0%,#8f1d4a 100%)!important;}`,
        // Editor header logo (when editor loads loveflix.js)
        `#lf-header .nf-logo{color:${hex}!important;}`,
        // Compiled editor bundle CSS variable overrides
        `.dark,html{--color-primary:${hex}!important;--color-accent:${hex}!important;--color-scrollbar-thumb:${hex}!important;}`,
      ].join('\n');
    } catch (_) {}
  }

  // Kick off a settings refresh on every page load. Pages that need to wait
  // for it can `await LoveFlix.ensureSettingsReady()`. We only pull when
  // authenticated; an anonymous pull would hit the public /api/settings
  // endpoint with the default tenant and could race-resolve the ready
  // promise with empty data, masking the real server response from the
  // post-signin pull.
  if (typeof document !== 'undefined') {
    const run = () => {
      // Apply cached color immediately (synchronous) to eliminate flash.
      applyBrandColor(getSettings());
      if (getToken()) {
        pullSettings().then(s => { applyBrandColor(s); }).catch(() => {});
      } else {
        resolveSettingsReady(getSettings());
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else { run(); }
    window.addEventListener('focus', () => {
      if (getToken()) pullSettings().then(s => { applyBrandColor(s); }).catch(() => {});
    });
    // Cross-tab updates: if another tab changes settings, mirror in this tab.
    window.addEventListener('storage', e => {
      if (e.key === SETTINGS_KEY) {
        applyBrandColor(getSettings());
        try { window.dispatchEvent(new Event('loveflix:settings-changed')); } catch (_) {}
      }
    });
  }

  function parseJwtUserId(token) {
    try {
      return JSON.parse(atob(token.split('.')[1])).sub;
    } catch { return null; }
  }

  function getUserId() {
    const u = getUser();
    if (u && u.id) return u.id;
    const token = getToken();
    return token ? parseJwtUserId(token) : null;
  }

  function getCoupleId() {
    try { return localStorage.getItem('loveflix_couple_id') || null; }
    catch { return null; }
  }

  function getCreatorId() {
    try { return localStorage.getItem('loveflix_creator_id') || null; }
    catch { return null; }
  }

  // After sign-in, look up the couple row for this user and cache its id +
  // billing-owner flag. Best-effort: failures are silent (the worker also
  // derives couple_id from the user on the server side).
  async function cacheCoupleId() {
    const userId = getUserId();
    const token = getToken();
    if (!userId || !token) return;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${userId}&select=couple_id,is_billing_owner,role&limit=1`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
          },
        }
      );
      if (!res.ok) return;
      const rows = await res.json();
      const row = rows && rows[0];
      if (!row) return;
      if (row.couple_id) localStorage.setItem('loveflix_couple_id', row.couple_id);
      if (row.role) localStorage.setItem('loveflix_role', row.role);
      if (typeof row.is_billing_owner === 'boolean') {
        localStorage.setItem('loveflix_is_billing_owner', row.is_billing_owner ? '1' : '0');
      }
      // Group the signed-in user into their couple so PostHog can do
      // couple-level funnels (active couples > DAU for this product).
      if (row.couple_id) {
        try {
          window.LoveFlixAnalytics && window.LoveFlixAnalytics.group('couple', row.couple_id, {
            is_billing_owner: !!row.is_billing_owner,
            role: row.role || null,
          });
        } catch (_) {}
      }
      // Cache the creator's (admin's) user_id so every API call targets the
      // shared couple tenant regardless of which partner is signed in.
      if (row.role === 'admin') {
        localStorage.setItem('loveflix_creator_id', userId);
      } else if (row.couple_id) {
        try {
          const r2 = await fetch(
            `${SUPABASE_URL}/rest/v1/couple_members?couple_id=eq.${row.couple_id}&role=eq.admin&select=user_id&limit=1`,
            { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
          );
          if (r2.ok) {
            const admins = await r2.json();
            const admin = admins && admins[0];
            if (admin && admin.user_id) localStorage.setItem('loveflix_creator_id', admin.user_id);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  function isBillingOwnerCached() {
    return localStorage.getItem('loveflix_is_billing_owner') === '1';
  }

  // Authoritative check — pings Supabase and refreshes the cache. Use this on
  // billing pages before enabling any subscription-mutating UI.
  async function fetchIsBillingOwner() {
    const userId = getUserId();
    const token = getToken();
    if (!userId || !token) return false;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${userId}&select=is_billing_owner&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return isBillingOwnerCached();
      const rows = await res.json();
      const flag = !!(rows && rows[0] && rows[0].is_billing_owner);
      localStorage.setItem('loveflix_is_billing_owner', flag ? '1' : '0');
      return flag;
    } catch { return isBillingOwnerCached(); }
  }

  // Fetch both members of the current user's couple. Returns
  // [{ user_id, display_name, role, is_billing_owner }, ...] (1 or 2 rows).
  async function fetchCoupleMembers() {
    const token = getToken();
    const coupleId = getCoupleId();
    if (!token || !coupleId) return [];
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?couple_id=eq.${coupleId}&select=user_id,display_name,role,is_billing_owner`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return [];
      const rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  // Push the current display names into Supabase couple_members so the chat
  // worker (which reads display_name when storing/broadcasting messages) and
  // any other Supabase-backed surface stay in sync with settings. Either
  // partner may update both rows — see the couple_members UPDATE policy in
  // supabase_rls_policies.sql (column-restricted to display_name).
  async function syncDisplayNames(adminName, partnerName) {
    const token = getToken();
    const coupleId = getCoupleId();
    if (!token || !coupleId) return;
    try {
      const members = await fetchCoupleMembers();
      for (const m of members) {
        const desired = m.role === 'admin' ? (adminName || m.display_name) : (partnerName || m.display_name);
        if (!desired || desired === m.display_name) continue;
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/couple_members?couple_id=eq.${coupleId}&user_id=eq.${m.user_id}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ display_name: desired }),
          }
        );
        if (!res.ok) console.warn('syncDisplayNames failed for', m.user_id, res.status);
      }
    } catch (e) {
      console.warn('syncDisplayNames error', e && e.message);
    }
  }

  // Mirror the names into the D1 couple_settings "locked" record so the
  // public-facing site and admin settings stay consistent.
  async function syncLockedNames(adminName, partnerName) {
    try {
      await api('/api/couple/settings', {
        method: 'PATCH',
        body: { partner_1_name: partnerName, partner_2_name: adminName },
      });
    } catch (e) {
      console.warn('syncLockedNames failed', e && e.message);
    }
  }

  async function getUserRole() {
    const userId = getUserId();
    const token = getToken();
    if (!userId || !token) return null;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${userId}&select=role&limit=1`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
          },
        }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      return (rows && rows[0] && rows[0].role) || null;
    } catch { return null; }
  }

  // ── Live message notification toast (iMessage-style) ────────────────────
  // Opens a background WebSocket to the chat Worker on every page so the user
  // gets a real-time popup when their partner sends a message. Singleton.
  let _notifWS = null;
  let _notifReconnectTimer = null;
  let _notifToastEl = null;

  function _ensureNotifStyles() {
    if (document.getElementById('lf-notif-style')) return;
    const s = document.createElement('style');
    s.id = 'lf-notif-style';
    s.textContent = [
      '#lf-msg-toast{position:fixed;bottom:28px;right:28px;z-index:9999;max-width:340px;background:rgba(14,8,12,0.96);border:1px solid rgba(255,95,143,0.35);border-radius:16px;padding:14px 16px;box-shadow:0 8px 40px rgba(0,0,0,0.6),0 0 0 1px rgba(255,95,143,0.06);-webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4);display:none;cursor:pointer;animation:lf-toast-in .35s cubic-bezier(.34,1.3,.64,1) both;font-family:\'Inter\',system-ui,sans-serif}',
      '#lf-msg-toast.lf-show{display:block}',
      '@keyframes lf-toast-in{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '#lf-msg-toast .lf-toast-row{display:flex;align-items:flex-start;gap:10px}',
      '#lf-msg-toast .lf-toast-avatar{width:36px;height:36px;border-radius:50%;flex-shrink:0;background:linear-gradient(135deg,#ff5f8f,#c9184a);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:#fff;font-family:\'Fraunces\',serif}',
      '#lf-msg-toast .lf-toast-body{flex:1;min-width:0}',
      '#lf-msg-toast .lf-toast-sender{font-size:13px;font-weight:600;color:#fff;margin-bottom:2px}',
      '#lf-msg-toast .lf-toast-text{font-size:12.5px;color:rgba(255,255,255,0.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#lf-msg-toast .lf-toast-close{background:none;border:none;color:rgba(255,255,255,0.3);font-size:16px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;align-self:flex-start;transition:color .15s}',
      '#lf-msg-toast .lf-toast-close:hover{color:#fff}',
      '@media(max-width:560px){#lf-msg-toast{right:16px;left:16px;max-width:none;bottom:16px}}',
    ].join('');
    document.head.appendChild(s);
  }

  function _ensureNotifToast() {
    if (_notifToastEl) return _notifToastEl;
    _ensureNotifStyles();
    const el = document.createElement('div');
    el.id = 'lf-msg-toast';
    el.innerHTML =
      '<div class="lf-toast-row">' +
        '<div class="lf-toast-avatar">♥</div>' +
        '<div class="lf-toast-body">' +
          '<div class="lf-toast-sender" id="lf-toast-sender"></div>' +
          '<div class="lf-toast-text" id="lf-toast-text"></div>' +
        '</div>' +
        '<button class="lf-toast-close" id="lf-toast-close-btn">×</button>' +
      '</div>';
    document.body.appendChild(el);

    // Click anywhere on the toast (except close button) → open chat
    el.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.lf-toast-close')) return;
      location.href = '/chat.html';
    });

    // Close button
    el.querySelector('#lf-toast-close-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      el.classList.remove('lf-show');
    });

    _notifToastEl = el;
    return el;
  }

  function _showMsgToast(senderName, text) {
    const el = _ensureNotifToast();
    document.getElementById('lf-toast-sender').textContent = senderName || 'Your Person';
    document.getElementById('lf-toast-text').textContent = text || '';
    el.classList.add('lf-show');

    // Auto-hide after 6 seconds
    clearTimeout(el._lfToastTimer);
    el._lfToastTimer = setTimeout(function () {
      el.classList.remove('lf-show');
    }, 6000);

    // Also update last-checked so the whos_watching polling toast doesn't also fire
    try { localStorage.setItem('lf_chat_last_checked', String(Date.now())); } catch (_) {}
  }

  function startMsgNotifications() {
    // Already connected or connecting
    if (_notifWS && (_notifWS.readyState === WebSocket.OPEN || _notifWS.readyState === WebSocket.CONNECTING)) return;

    // Skip on the chat page itself — messages are shown inline there
    const page = (location.pathname.split('/').pop() || '').replace(/\?.*$/, '');
    if (page === 'chat.html') return;

    const token = getToken();
    if (!token) return;

    const chatApi = localStorage.getItem('lf_chat_api') || 'https://loveflix-chat.adrienmuhabukibusiness.workers.dev';
    const wsUrl = chatApi.replace(/^http/, 'ws') + '/api/connect?token=' + encodeURIComponent(token);

    clearTimeout(_notifReconnectTimer);

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = function () {
        // connected — no action needed, just listening
      };

      ws.onmessage = function (e) {
        try {
          const data = JSON.parse(e.data);
          // Only show toasts for partner messages, and respect the notification toggle
          if (data.type === 'message' && data.sender_id !== getUserId()) {
            const settings = getSettings();
            const notifEnabled = settings.notifications_enabled !== false; // default to on
            if (notifEnabled) {
              _showMsgToast(data.sender_name, data.text);
            }
          }
        } catch (_) {}
      };

      ws.onclose = function () {
        _notifWS = null;
        _notifReconnectTimer = setTimeout(startMsgNotifications, 5000);
      };

      ws.onerror = function () { ws.close(); };

      _notifWS = ws;
    } catch (_) {
      _notifReconnectTimer = setTimeout(startMsgNotifications, 5000);
    }
  }

  global.LoveFlix = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    getToken,
    refreshSession,
    ensureFreshToken,
    getUserId,
    getCoupleId,
    getCreatorId,
    cacheCoupleId,
    getUserRole,
    isBillingOwnerCached,
    fetchIsBillingOwner,
    fetchCoupleMembers,
    syncDisplayNames,
    syncLockedNames,
    getUser,
    setSession,
    clearSession,
    getSettings,
    saveSettings,
    clearSettings,
    pullSettings,
    pushSettings,
    flushPushSettings,
    ensureSettingsReady,
    applyBrandColor,
    signIn,
    signUp,
    signInWithOAuth,
    handleOAuthRedirect,
    signOut,
    requireAuth,
    startPresence,
    api,
    putWithProgress,
    getActiveProfile,
    paintNavAvatar,
  };
})(window);
