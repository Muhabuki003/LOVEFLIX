// LoveFlix API — Cloudflare Pages Function (catch-all under /api/*)
// Routes handled here:
//   GET    /api/videos
//   POST   /api/videos
//   DELETE /api/videos/:id
//   GET    /api/upload-url?filename=...&type=...
//   PUT    /api/upload-object?key=...
//   POST   /api/videos/presign       (editor save-to-LoveFlix)
//   POST   /api/videos/confirm       (editor save-to-LoveFlix)
//   GET    /api/progress
//   POST   /api/progress
//   GET    /api/health

const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/videos',
  'GET /api/settings',
  'POST /api/create-payment-intent',
  'POST /api/create-checkout-session',
  'POST /api/create-subscription-intent',
  'POST /api/activate-subscription',
  'GET /api/billing/subscription',
  'GET /api/stripe-config',
  'GET /api/posthog-config',
  'POST /api/stripe-webhook',
  'POST /api/join-partner',
  // Google Maps JS API key for the LoveConnect navigation map. The page fetches
  // this on load (no auth header) before any token-gated work, and the key is a
  // referrer-restricted public client key that ships in the Maps script URL
  // anyway — so it is intentionally public here. Lock it down with an HTTP
  // referrer restriction in the Google Cloud console.
  'GET /api/maps-config',
  // YouTube search — public so the music page can search before
  // the auth token is fully checked.
  'GET /api/youtube/search',
  'GET /api/music/recent',
  'GET /api/music/yt-match',
  'GET /api/music/search',
  // Provider config for the music connectors. Spotify client id and the Apple
  // Music developer token are public client-side values by design (the Spotify
  // secret, if configured, never leaves the worker; Apple developer tokens are
  // meant to ship to MusicKit JS in the browser).
  'GET /api/music/spotify-config',
  'GET /api/music/apple-config',
  // AI chat is intentionally NOT in PUBLIC_ROUTES — it calls DeepSeek at cost.
  // Unauthenticated landing-page users are allowed through by the auth block
  // below (user will be null) but are subject to IP rate limiting.
]);

// LoveFlix plan catalog. Prices in cents (USD). Source of truth for checkout amount.
const LOVEFLIX_PLANS = {
  crush:      { name: 'Crush',      price: 600,  display: '$6',  blurb: '25 videos · 1080p' },
  sweetheart: { name: 'Sweetheart', price: 1200, display: '$12', blurb: 'Unlimited · 4K HDR' },
  forever:    { name: 'Forever',    price: 2400, display: '$24', blurb: 'All features · concierge' },
};

// json() picks up the per-request origin stored at the top of onRequest.
let _reqOrigin = '';
// Stashed at the top of onRequest so phCapture() can hand off to the
// runtime without each handler having to thread `ctx` through its signature.
let _waitUntil = null;

// Fire-and-forget PostHog capture from a Cloudflare Worker. Uses the
// public /i/v0/e/ batch endpoint. No-ops when POSTHOG_PROJECT_API_KEY is
// unset so staging/local dev stays clean.
async function phCapture(env, { distinctId, event, properties }) {
  const key = env.POSTHOG_PROJECT_API_KEY;
  if (!key || !distinctId || !event) return;
  const host = (env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const fire = fetch(host + '/i/v0/e/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      distinct_id: distinctId,
      event,
      properties: properties || {},
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {});
  if (_waitUntil) _waitUntil(fire); else await fire;
}
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(_reqOrigin),
      ...extra,
    },
  });

// Only allow https URLs (or data-less http in dev) to prevent javascript:/data: injection
function validateHttpsUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

// Ensure an invite redirect URL belongs to our own domain
function validateInviteUrl(raw, reqOrigin) {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const allowed = new Set([...ALLOWED_ORIGINS, reqOrigin].filter(Boolean));
    return allowed.has(u.origin) || u.hostname === 'localhost';
  } catch { return false; }
}

const ALLOWED_ORIGINS = new Set([
  'https://loveflix.so',
  'https://www.loveflix.so',
  'http://localhost:3000',
  'http://localhost:8788',
]);

function corsHeaders(requestOrigin) {
  const origin = ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : 'https://loveflix.so';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-tenant-id',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

// ── Rate limiting via Cloudflare KV ─────────────────────────────────────────
// Returns a 429 Response when the caller exceeds `maxRequests` within
// `windowSeconds`. Returns null when the request is within limits.
// Keyed by: rl:<bucket>:<identifier>:<window-epoch>
async function checkRateLimit(env, identifier, bucket, maxRequests, windowSeconds) {
  if (!env.RATE_LIMIT_KV) return null; // fail open until KV namespace is provisioned
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rl:${bucket}:${identifier}:${window}`;
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || '0') + 1;
  // TTL is double the window so keys always expire even if clock skews
  await env.RATE_LIMIT_KV.put(key, String(current), { expirationTtl: windowSeconds * 2 });
  if (current > maxRequests) {
    return json(
      { error: 'rate_limit_exceeded', retry_after: windowSeconds },
      429,
      { 'retry-after': String(windowSeconds) }
    );
  }
  return null;
}

// ── NeMo Guardrails: Input Rail — prompt-injection patterns ──────────────────
// Blocks payloads that attempt to hijack any LLM that later reads this data.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i,
  /system\s*:\s*you\s+are/i,
  /\[(?:INST|SYS)\]|<\|im_(?:start|end)\|>/,
  /\bJailbreak\b|\bDANmode\b/i,
  /<!--[\s\S]*?-->/,                        // HTML comment injection
  /\}\s*\{[^}]*"role"\s*:/,                // JSON role injection
];

function sanitizeUserText(text, maxLen = 500) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim().slice(0, maxLen);
  if (INJECTION_PATTERNS.some(p => p.test(trimmed))) return '';
  return trimmed;
}

// ── Tenant ownership verification via Supabase couple_members (RLS-protected) ─
// The tenant key is the couple creator's (admin's) auth user_id. A caller may
// access their own tenant, or the tenant of anyone they share a couple with.
async function verifyTenantAccess(env, user, requestedTenantId) {
  if (!requestedTenantId || requestedTenantId === user.id) return requestedTenantId || user.id;
  try {
    // couple_members SELECT RLS only returns rows in the caller's own couple
    // (user_id = auth.uid() OR couple_id = get_my_couple_id()). So a hit when
    // querying by the requested tenant's user_id proves they share a couple.
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${encodeURIComponent(requestedTenantId)}&select=couple_id&limit=1`,
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${user.token}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return (rows && rows.length > 0) ? requestedTenantId : null;
  } catch { return null; }
}

export async function onRequest(context) {
  const { request, env } = context;
  _reqOrigin = request.headers.get('origin') || '';
  _waitUntil = typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : null;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || url.pathname;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(_reqOrigin) });

  try {
    const routeKey = `${method} ${path}`;
    // YouTube search has a dynamic segment so it can't be in PUBLIC_ROUTES set.
    const isYouTubeRoute = method === 'GET' && path.startsWith('/api/youtube/');
    // /api/ai is NOT in PUBLIC_ROUTES but we allow null-user callers (landing widget).
    const isAiRoute = method === 'POST' && path === '/api/ai';
    const isPublic = PUBLIC_ROUTES.has(routeKey) || isYouTubeRoute || isAiRoute;

    let user = null;
    if (!isPublic) {
      user = await authenticate(request, env);
      if (!user) return json({ error: 'unauthorized' }, 401);
    } else {
      user = await authenticate(request, env).catch(() => null);
    }

    // Structured request log — every call, every endpoint.
    const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
    console.log(JSON.stringify({
      ts: Date.now(), method, path,
      uid: user?.id ?? null,
      ip: clientIP,
    }));

    // ── Rate limiting ────────────────────────────────────────────────────────
    // AI endpoint: 20 req/min per IP (abuse guard), 50 req/day per identity.
    if (isAiRoute) {
      const ipLimited = await checkRateLimit(env, clientIP, 'ai_ip', 20, 60);
      if (ipLimited) return ipLimited;
      const identity = user?.id || clientIP;
      const dayLimited = await checkRateLimit(env, identity, 'ai_day', 50, 86400);
      if (dayLimited) return dayLimited;
    }

    // Invite redemption: 5 attempts/hour per IP — prevents invite-code brute-force.
    if (method === 'POST' && path === '/api/join-partner') {
      const limited = await checkRateLimit(env, clientIP, 'join', 5, 3600);
      if (limited) return limited;
    }

    // YouTube search: 60 req/min per IP.
    if (isYouTubeRoute) {
      const limited = await checkRateLimit(env, clientIP, 'yt', 60, 60);
      if (limited) return limited;
    }

    // Google Directions proxy: 30 req/min per IP.
    if (method === 'GET' && path === '/api/directions') {
      const limited = await checkRateLimit(env, clientIP, 'dir', 30, 60);
      if (limited) return limited;
    }

    // YouTube match proxy: 20 req/min per IP.
    if (method === 'GET' && path === '/api/music/yt-match') {
      const limited = await checkRateLimit(env, clientIP, 'yt', 20, 60);
      if (limited) return limited;
    }

    // Music search (YouTube Data API): 30 req/min per IP.
    if (method === 'GET' && path === '/api/music/search') {
      const limited = await checkRateLimit(env, clientIP, 'msearch', 30, 60);
      if (limited) return limited;
    }

    // Spotify token exchange/refresh: 10 req/min per user.
    if (method === 'POST' && path === '/api/music/spotify/token') {
      const limited = await checkRateLimit(env, user?.id || clientIP, 'sptoken', 10, 60);
      if (limited) return limited;
    }
    // ────────────────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/api/health') return json({
      ok: true,
      // Booleans only — never the secret values. Lets us confirm which deployment
      // environment actually has the keys wired (diagnoses /api/ai 503s, etc.).
      deepseek: !!env.DEEPSEEK_API_KEY,
      places: !!(env.GOOGLE_PLACES_API_KEY || env.GOOGLE_MAPS_API_KEY),
      couple_context_kv: !!env.COUPLE_CONTEXT_KV,
    });

    if (method === 'GET' && path === '/api/videos') return listVideos(env, url, user, request);
    if (method === 'POST' && path === '/api/videos') return createVideo(env, request, user);

    const videoIdMatch = path.match(/^\/api\/videos\/([^/]+)$/);
    if (videoIdMatch && method === 'DELETE') return deleteVideo(env, videoIdMatch[1], user);
    if (videoIdMatch && method === 'PATCH') return updateVideo(env, videoIdMatch[1], request, user);
    if (videoIdMatch && method === 'GET') return getVideo(env, videoIdMatch[1]);

    if (method === 'GET' && path === '/api/upload-url') return getUploadUrl(env, url, user);
    if (method === 'PUT' && path === '/api/upload-object') return uploadObject(env, request, url, user);

    // Editor "Save to LoveFlix" flow.
    if (method === 'POST' && path === '/api/videos/presign') return presignVideoUpload(env, request, url, user);
    if (method === 'POST' && path === '/api/videos/confirm') return confirmVideoUpload(env, request, user);

    if (method === 'GET' && path === '/api/progress') return listProgress(env, user);
    if (method === 'POST' && path === '/api/progress') return saveProgress(env, request, user);

    if (method === 'POST' && path === '/api/send-invite') return sendInvite(env, request, user);
    if (method === 'POST' && path === '/api/join-partner') return joinPartner(env, request);

    if (method === 'GET' && path === '/api/settings') return getSettings(env, url, user, request);
    if (method === 'PUT' && path === '/api/settings') return putSettings(env, request, user);

    if (method === 'GET'   && path === '/api/couple/settings') return getCoupleSettings(env, user);
    if (method === 'PATCH' && path === '/api/couple/settings') return patchCoupleSettings(env, request, user);

    if (method === 'POST' && path === '/api/create-checkout-session') return createCheckoutSession(env, request, url);
    if (method === 'POST' && path === '/api/create-subscription-intent') return createSubscriptionIntent(env, request);
    if (method === 'POST' && path === '/api/activate-subscription') return activateSubscription(env, request);
    if (method === 'POST' && path === '/api/create-payment-intent') return createPaymentIntent(env, request);
    if (method === 'POST' && path === '/api/stripe-webhook') return handleStripeWebhook(env, request);
    if (method === 'GET'  && path === '/api/billing/subscription') return getBillingSubscription(env, request);
    if (method === 'GET'  && path === '/api/stripe-config') {
      return json({
        publishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
        plans: LOVEFLIX_PLANS,
      });
    }

    // PostHog project key is public (phc_…) — safe to hand out to any caller.
    // Returning '' when unset lets the client silently disable analytics.
    if (method === 'GET' && path === '/api/posthog-config') {
      return json({
        key: env.POSTHOG_PROJECT_API_KEY || '',
        host: env.POSTHOG_HOST || 'https://us.i.posthog.com',
      });
    }

    if (method === 'POST' && path === '/api/livekit-token') return livekitToken(env, request, user);

    // Hands the Google Maps JS API key to the LoveConnect page so it can inject
    // the Maps script without the key ever being hardcoded in static HTML.
    // Only serve the key to requests originating from our own domains.
    if (method === 'GET' && path === '/api/maps-config') {
      if (!ALLOWED_ORIGINS.has(_reqOrigin)) {
        return json({ error: 'forbidden' }, 403);
      }
      return json({ key: env.GOOGLE_MAPS_API_KEY || '' });
    }

    if (method === 'GET' && path === '/api/directions') return getDirections(env, url, user);

    // Music search — YouTube Data API, biased toward "official audio"/official
    // channels. /api/youtube/search is a legacy alias for the same handler.
    if (method === 'GET' && (path === '/api/music/search' || path === '/api/youtube/search')) {
      return musicSearch(env, url);
    }

    // Music connectors: provider config + Spotify token proxy.
    if (method === 'GET' && path === '/api/music/spotify-config') {
      return json({ clientId: env.SPOTIFY_CLIENT_ID || '' });
    }
    if (method === 'GET' && path === '/api/music/apple-config') {
      return json({ developerToken: env.APPLE_MUSIC_DEVELOPER_TOKEN || '' });
    }
    if (method === 'POST' && path === '/api/music/spotify/token') {
      return spotifyToken(env, request, user);
    }

    // Music tracking endpoints
    if (method === 'POST' && path === '/api/music/plays') return saveMusicPlay(env, request, user);
    const musicPlaysMatch = path.match(/^\/api\/music\/plays\/([^/]+)$/);
    if (musicPlaysMatch && method === 'GET') return getMusicPlays(env, musicPlaysMatch[1], user);

    // Music playlist endpoints
    if (method === 'GET'  && path === '/api/music/playlists') return listPlaylists(env, url, user);
    if (method === 'POST' && path === '/api/music/playlists') return createPlaylist(env, request, user);
    const plMatch  = path.match(/^\/api\/music\/playlists\/([^/]+)$/);
    const plsMatch = path.match(/^\/api\/music\/playlists\/([^/]+)\/songs$/);
    const plssMatch = path.match(/^\/api\/music\/playlists\/([^/]+)\/songs\/([^/]+)$/);
    if (plMatch)  {
      if (method === 'GET')    return getPlaylist(env, plMatch[1], user);
      if (method === 'DELETE') return deletePlaylist(env, plMatch[1], user);
    }
    if (plsMatch) {
      if (method === 'GET')  return listPlaylistSongs(env, plsMatch[1], user);
      if (method === 'POST') return addToPlaylist(env, plsMatch[1], request, user);
    }
    if (plssMatch && method === 'DELETE') return removeFromPlaylist(env, plssMatch[1], plssMatch[2], user);

    // Music recent plays (for home page widget)
    if (method === 'GET' && path === '/api/music/recent') return getMusicRecent(env, url, user);

    // YouTube track match — returns a YouTube videoId for full-song playback
    if (method === 'GET' && path === '/api/music/yt-match') return ytMatch(env, url);

    // Favorites (My List)
    if (method === 'POST'   && path === '/api/ai') return handleAiChat(env, request, user);

    if (method === 'GET'    && path === '/api/favorites') return listFavorites(env, user);
    if (method === 'GET'    && path === '/api/couple-stats') return getCoupleStats(env, request, user);
    if (method === 'GET'    && path === '/api/couple-context') return getCoupleContextRoute(env, request, user, url);
    const favMatch = path.match(/^\/api\/favorites\/([^/]+)$/);
    if (favMatch && method === 'POST')   return addFavorite(env, favMatch[1], user);
    if (favMatch && method === 'DELETE') return removeFavorite(env, favMatch[1], user);

    return json({ error: 'not_found', path }, 404);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('API route failed', { method, path, message, stack: err && err.stack });
    // Never expose internal error details to clients
    return json({ error: 'server_error' }, 500);
  }
}

// ---------- Auth ----------
// Validate a Supabase JWT by calling /auth/v1/user. Lightweight, no JWT secret needed.
async function authenticate(request, env) {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const u = await res.json();
  if (!u || !u.id) return null;
  return { id: u.id, email: u.email || '', token };
}

// ---------- Videos ----------
async function listVideos(env, url, user, request) {
  const requested = (request && request.headers.get('x-tenant-id')) || url.searchParams.get('tenant') || (user && user.id) || env.DEFAULT_TENANT_ID || 'default';
  const tenantId = user
    ? (await verifyTenantAccess(env, user, requested) || (user && user.id))
    : (env.DEFAULT_TENANT_ID || 'default');
  let results;
  if (user) {
    const stmt = env.DB.prepare(
      `SELECT v.id, v.tenant_id, v.title, v.description, v.date, v.category,
              v.thumbnail_url, v.video_url, v.duration_seconds, v.is_published,
              v.display_order, v.created_at,
              CASE WHEN f.video_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite
         FROM videos v
         LEFT JOIN favorites f ON f.video_id = v.id AND f.user_id = ?
        WHERE v.tenant_id = ? AND v.is_published = 1
        ORDER BY v.display_order ASC, v.created_at DESC`
    ).bind(user.id, tenantId);
    ({ results } = await stmt.all());
  } else {
    const stmt = env.DB.prepare(
      `SELECT id, tenant_id, title, description, date, category,
              thumbnail_url, video_url, duration_seconds, is_published,
              display_order, created_at
         FROM videos
        WHERE tenant_id = ? AND is_published = 1
        ORDER BY display_order ASC, created_at DESC`
    ).bind(tenantId);
    ({ results } = await stmt.all());
  }
  return json({ videos: results || [] });
}

async function getVideo(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, tenant_id, title, description, date, category,
            thumbnail_url, video_url, duration_seconds, is_published,
            display_order, created_at
       FROM videos WHERE id = ?`
  ).bind(id).first();
  if (!row) return json({ error: 'not_found' }, 404);
  return json({ video: row });
}

async function createVideo(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const id = body.id || `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Verify caller belongs to the requested tenant before writing to it
  const requestedTenant = request.headers.get('x-tenant-id') || user.id;
  const tenantId = await verifyTenantAccess(env, user, requestedTenant);
  if (!tenantId) return json({ error: 'forbidden' }, 403);

  const isPublished = body.is_published === false ? 0 : 1;
  const thumbnailUrl = body.thumbnail_url || '';

  if (thumbnailUrl.startsWith('data:')) {
    return json({
      error: 'thumbnail_not_uploaded',
      message: 'Custom thumbnails must be uploaded to R2 and saved as a public URL, not stored inline as a data URL.',
    }, 400);
  }

  // Reject non-http(s) thumbnail URLs (blocks javascript:, data:, css-injection payloads)
  if (thumbnailUrl && !validateHttpsUrl(thumbnailUrl)) {
    return json({ error: 'invalid_thumbnail_url' }, 400);
  }

  // NeMo input rail: sanitize free-text fields before persisting (blocks prompt injection)
  const title = sanitizeUserText(body.title || 'Untitled', 200) || 'Untitled';
  const description = sanitizeUserText(body.description || '', 2000);
  const category = sanitizeUserText(body.category || 'Moments', 100) || 'Moments';

  await env.DB.prepare(
    `INSERT INTO videos
       (id, tenant_id, title, description, date, category,
        thumbnail_url, video_url, duration_seconds, is_published, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    tenantId,
    title,
    description,
    body.date || '',
    category,
    thumbnailUrl,
    body.video_url || '',
    parseInt(body.duration_seconds || 0, 10) || 0,
    isPublished,
    parseInt(body.display_order || 0, 10) || 0
  ).run();

  return json({ id, ok: true }, 201);
}

async function deleteVideo(env, id, user) {
  const row = await env.DB.prepare(`SELECT video_url, tenant_id FROM videos WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'not_found' }, 404);

  // Verify the caller owns (or belongs to) this video's tenant before deleting
  const allowed = await verifyTenantAccess(env, user, row.tenant_id);
  if (!allowed) return json({ error: 'forbidden' }, 403);

  // Best-effort R2 delete if the URL is in our bucket.
  if (row.video_url) {
    const key = extractR2Key(row.video_url, env);
    if (key) {
      try { await env.VIDEOS.delete(key); } catch (_) {}
    }
  }
  await env.DB.prepare(`DELETE FROM videos WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function updateVideo(env, id, request, user) {
  const row = await env.DB.prepare(`SELECT tenant_id FROM videos WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'not_found' }, 404);

  const allowed = await verifyTenantAccess(env, user, row.tenant_id);
  if (!allowed) return json({ error: 'forbidden' }, 403);

  const body = await request.json().catch(() => ({}));
  const updates = {};
  let hasUpdates = false;

  if (typeof body.is_published === 'boolean' || typeof body.is_published === 'number') {
    updates.is_published = body.is_published ? 1 : 0;
    hasUpdates = true;
  }
  if (typeof body.title === 'string') {
    updates.title = sanitizeUserText(body.title, 200) || 'Untitled';
    hasUpdates = true;
  }
  if (typeof body.description === 'string') {
    updates.description = sanitizeUserText(body.description, 2000);
    hasUpdates = true;
  }
  if (typeof body.category === 'string') {
    updates.category = sanitizeUserText(body.category, 100) || 'Moments';
    hasUpdates = true;
  }

  if (!hasUpdates) return json({ error: 'no_updates' }, 400);

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(id);

  await env.DB.prepare(`UPDATE videos SET ${setClauses} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}

function extractR2Key(urlOrKey, env) {
  if (!urlOrKey) return null;
  if (!urlOrKey.startsWith('http')) return urlOrKey;
  try {
    const u = new URL(urlOrKey);
    return u.pathname.replace(/^\/+/, '');
  } catch {
    return null;
  }
}

// ---------- Editor save-to-LoveFlix ----------
async function presignVideoUpload(env, request, url, user) {
  const body = await request.json().catch(() => ({}));
  const rawName = (body.filename || `editor-${Date.now()}.mp4`).toString();
  const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const contentType = body.contentType || 'video/mp4';
  const videoId = `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const key = `videos/${user.id}/${Date.now()}-${filename}`;

  // Insert a pending row so the dashboard can reflect it after confirm.
  await env.DB.prepare(
    `INSERT INTO videos
       (id, tenant_id, title, description, date, category,
        thumbnail_url, video_url, duration_seconds, is_published, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    videoId, user.id, filename.slice(0, 200), '', '', 'Moments',
    '', '', 0, 0, 0
  ).run();

  if (env.VIDEOS) {
    return json({
      videoId,
      key,
      uploadUrl: `${url.origin}/api/upload-object?key=${encodeURIComponent(key)}`,
      contentType,
    });
  }

  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET_NAME;
  if (!accessKey || !secretKey || !accountId || !bucket) {
    return json({ error: 'r2_not_configured' }, 500);
  }
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const uploadUrl = await presignS3PutUrl({
    accessKey, secretKey, region: 'auto', service: 's3',
    host, bucket, key, expiresIn: 3600, contentType,
  });
  return json({ videoId, key, uploadUrl, contentType });
}

async function confirmVideoUpload(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const { videoId, key, filename } = body;
  if (!videoId || !key) return json({ error: 'videoId and key required' }, 400);

  const publicUrl = env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
    : `/r2/${key}`;

  const title = (filename || 'Edited video').toString().replace(/\.[^.]+$/, '').slice(0, 200);

  const result = await env.DB.prepare(
    `UPDATE videos
        SET video_url = ?, title = ?, is_published = 1
      WHERE id = ? AND tenant_id = ?`
  ).bind(publicUrl, title, videoId, user.id).run();

  if (!result.success) return json({ error: 'update_failed' }, 500);
  return json({ ok: true, videoId, video_url: publicUrl });
}

// ---------- Watch progress ----------
async function listProgress(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT video_id, progress_seconds, completed, last_watched_at
       FROM watch_progress
      WHERE user_id = ?
      ORDER BY last_watched_at DESC`
  ).bind(user.id).all();
  return json({ progress: results || [] });
}

async function saveProgress(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const videoId = body.video_id;
  if (!videoId) return json({ error: 'video_id required' }, 400);
  const seconds = Math.max(0, parseInt(body.progress_seconds || 0, 10) || 0);
  const completed = body.completed ? 1 : 0;
  const id = `${user.id}_${videoId}`;

  await env.DB.prepare(
    `INSERT INTO watch_progress (id, user_id, video_id, progress_seconds, completed, last_watched_at)
     VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(user_id, video_id) DO UPDATE SET
       progress_seconds = excluded.progress_seconds,
       completed        = excluded.completed,
       last_watched_at  = excluded.last_watched_at`
  ).bind(id, user.id, videoId, seconds, completed).run();

  // Fire only on completion — the per-tick saves would spam PostHog. A
  // `video_playback_started` event is captured client-side in player.html,
  // so started→completed forms a clean funnel without per-tick noise.
  if (completed) {
    await phCapture(env, {
      distinctId: user.id,
      event: 'video_playback_completed',
      properties: { video_id: videoId, watched_seconds: seconds },
    });
  }

  return json({ ok: true });
}

// ---------- Tenant Settings ----------
async function getSettings(env, url, user, request) {
  const requested = (request && request.headers.get('x-tenant-id')) || url.searchParams.get('tenant') || (user && user.id) || env.DEFAULT_TENANT_ID || 'default';
  const tenantId = user
    ? (await verifyTenantAccess(env, user, requested) || (user && user.id))
    : (env.DEFAULT_TENANT_ID || 'default');
  const row = await env.DB.prepare(
    `SELECT data, updated_at FROM tenant_settings WHERE tenant_id = ?`
  ).bind(tenantId).first();
  if (!row) return json({ settings: {}, updated_at: 0 });
  let parsed = {};
  try { parsed = JSON.parse(row.data) || {}; } catch (_) {}
  return json({ settings: parsed, updated_at: row.updated_at || 0 });
}

async function putSettings(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const settings = (body && typeof body.settings === 'object' && body.settings) || {};
  const requestedTenant = request.headers.get('x-tenant-id') || user.id;
  const tenantId = await verifyTenantAccess(env, user, requestedTenant);
  if (!tenantId) return json({ error: 'forbidden' }, 403);
  const data = JSON.stringify(settings);
  if (data.length > 900_000) {
    return json({ error: 'settings_too_large', message: 'Settings payload exceeds 900KB. Trim photos or other large fields.' }, 413);
  }
  await env.DB.prepare(
    `INSERT INTO tenant_settings (tenant_id, data, updated_at)
     VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(tenant_id) DO UPDATE SET
       data = excluded.data,
       updated_at = excluded.updated_at`
  ).bind(tenantId, data).run();
  return json({ ok: true });
}

// ---------- R2 upload URL ----------
async function getUploadUrl(env, url, user) {
  const filename = (url.searchParams.get('filename') || `upload-${Date.now()}.bin`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const contentType = url.searchParams.get('type') || 'application/octet-stream';
  const folder = url.searchParams.get('folder') || 'videos';
  const key = `${folder}/${user.id}/${Date.now()}-${filename}`;

  const publicUrl = env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
    : null;

  // Prefer the Cloudflare Pages R2 binding. This is already configured in
  // wrangler.toml/Pages as binding `VIDEOS` => bucket `loveflix-videos`, and
  // avoids requiring separate R2 S3 API secrets for browser uploads.
  if (env.VIDEOS) {
    return json({
      upload_url: `${url.origin}/api/upload-object?key=${encodeURIComponent(key)}`,
      key,
      public_url: publicUrl,
      content_type: contentType,
      expires_in: 3600,
      upload_method: 'binding',
    });
  }

  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET_NAME;

  if (!accessKey || !secretKey || !accountId || !bucket) {
    return json({
      error: 'r2_not_configured',
      message: 'R2 binding `VIDEOS` or R2 S3 API credentials are not configured.',
    }, 500);
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const presigned = await presignS3PutUrl({
    accessKey,
    secretKey,
    region: 'auto',
    service: 's3',
    host,
    bucket,
    key,
    expiresIn: 3600,
    contentType,
  });

  return json({
    upload_url: presigned,
    key,
    public_url: publicUrl || `https://${host}/${bucket}/${key}`,
    content_type: contentType,
    expires_in: 3600,
    upload_method: 's3_presigned',
  });
}

async function uploadObject(env, request, url, user) {
  if (!env.VIDEOS) {
    return json({ error: 'r2_not_configured', message: 'R2 binding `VIDEOS` is not configured.' }, 500);
  }

  const key = url.searchParams.get('key');
  if (!key) return json({ error: 'missing_key' }, 400);

  // Constrain uploads to the authenticated user's folder to prevent arbitrary
  // overwrites if an upload URL is copied or modified.
  if (!key.startsWith(`videos/${user.id}/`) && !key.startsWith(`images/${user.id}/`)) {
    return json({ error: 'forbidden_key' }, 403);
  }

  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  await env.VIDEOS.put(key, request.body, {
    httpMetadata: { contentType },
  });

  return json({ ok: true, key });
}

// AWS SigV4 query-string presign for `PUT s3://bucket/key`.
async function presignS3PutUrl({ accessKey, secretKey, region, service, host, bucket, key, expiresIn, contentType }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKey}/${credentialScope}`;
  const signedHeaders = 'content-type;host';

  const canonicalUri = `/${bucket}/${encodeKey(key)}`;
  const params = new URLSearchParams();
  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential', credential);
  params.set('X-Amz-Date', amzDate);
  params.set('X-Amz-Expires', String(expiresIn));
  params.set('X-Amz-SignedHeaders', signedHeaders);
  // Sort keys for canonical query string.
  const canonicalQuery = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = bytesToHex(await hmac(kSigning, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function encodeKey(key) {
  return key.split('/').map(encodeRfc3986).join('/');
}
function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return bytesToHex(new Uint8Array(buf));
}
async function hmac(key, data) {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
  return new Uint8Array(sig);
}
function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Stripe ----------

function stripeRequest(secretKey, path, params) {
  const isGet = !params;
  return fetch(`https://api.stripe.com/v1${path}`, {
    method: isGet ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: isGet ? undefined : new URLSearchParams(params).toString(),
  }).then(r => r.json());
}

// POST /api/create-checkout-session
// Body: { plan: 'crush'|'sweetheart'|'forever', billing: 'monthly'|'yearly', email?: string }
async function createCheckoutSession(env, request, url) {
  const body = await request.json().catch(() => ({}));
  const planId = (body.plan || 'sweetheart').toString().toLowerCase();
  const billing = (body.billing || 'monthly').toString().toLowerCase();

  const plan = LOVEFLIX_PLANS[planId];
  if (!plan) return json({ error: 'invalid_plan' }, 400);
  if (billing !== 'monthly' && billing !== 'yearly') return json({ error: 'invalid_billing' }, 400);

  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return json({ error: 'stripe_not_configured', hint: 'Run: wrangler pages secret put STRIPE_SECRET_KEY' }, 500);

  const priceEnvKey = `STRIPE_PRICE_${planId.toUpperCase()}_${billing.toUpperCase()}`;
  const priceId = env[priceEnvKey];
  if (!priceId) return json({ error: 'price_not_configured', hint: `Set ${priceEnvKey} in wrangler.toml after running stripe-setup.js` }, 500);

  const origin = url.origin;
  const params = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: `${origin}/setup/complete?session_id={CHECKOUT_SESSION_ID}&plan=${planId}&billing=${billing}`,
    cancel_url: `${origin}/pricing.html`,
    'subscription_data[trial_period_days]': '14',
    'subscription_data[metadata][plan_id]': planId,
    'subscription_data[metadata][billing]': billing,
  };
  if (body.email) params.customer_email = body.email.toString().slice(0, 320);

  const session = await stripeRequest(secretKey, '/checkout/sessions', params);
  if (session.error) return json({ error: session.error.message }, 500);

  await phCapture(env, {
    distinctId: body.email ? `email_${body.email.toString().toLowerCase()}` : 'anonymous_checkout',
    event: 'checkout_started',
    properties: {
      plan: planId,
      interval: billing,
      price_id: priceId,
      stripe_session_id: session.id,
    },
  });

  return json({ url: session.url, sessionId: session.id });
}

// POST /api/create-subscription-intent
// Body: { plan, billing, email? }
// Creates a Stripe Customer + SetupIntent so the frontend can collect and save card
// details without charging. The card is charged after the 14-day trial via activateSubscription.
async function createSubscriptionIntent(env, request) {
  const body = await request.json().catch(() => ({}));
  const planId  = (body.plan    || 'sweetheart').toString().toLowerCase();
  const billing = (body.billing || 'monthly').toString().toLowerCase();
  const email   = (body.email   || '').toString().slice(0, 320);

  if (!LOVEFLIX_PLANS[planId]) return json({ error: 'invalid_plan' }, 400);
  if (billing !== 'monthly' && billing !== 'yearly') return json({ error: 'invalid_billing' }, 400);

  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return json({ error: 'stripe_not_configured' }, 500);

  // Create a Customer so we can attach the payment method and create a subscription.
  const customerParams = { 'metadata[plan_id]': planId, 'metadata[billing]': billing };
  if (email) customerParams.email = email;
  const customer = await stripeRequest(secretKey, '/customers', customerParams);
  if (customer.error) return json({ error: customer.error.message }, 500);

  // SetupIntent: saves the card with no charge. usage=off_session so it can charge
  // automatically after the trial ends.
  const setup = await stripeRequest(secretKey, '/setup_intents', {
    customer: customer.id,
    usage: 'off_session',
    'automatic_payment_methods[enabled]': 'true',
    'metadata[plan_id]': planId,
    'metadata[billing]': billing,
  });
  if (setup.error) return json({ error: setup.error.message }, 500);

  return json({
    clientSecret:    setup.client_secret,
    customerId:      customer.id,
    setupIntentId:   setup.id,
    publishableKey:  env.STRIPE_PUBLISHABLE_KEY || '',
    planId,
    billing,
  });
}

// POST /api/activate-subscription
// Body: { setupIntentId, customerId, planId, billing }
// Called after the frontend successfully confirms the SetupIntent.
// Retrieves the saved payment method and creates the subscription with a trial.
async function activateSubscription(env, request) {
  const body = await request.json().catch(() => ({}));
  const { setupIntentId, customerId, planId, billing } = body;

  if (!setupIntentId || !customerId) return json({ error: 'missing_fields' }, 400);

  const safeId      = LOVEFLIX_PLANS[planId] ? planId : 'sweetheart';
  const safeBilling = billing === 'yearly' ? 'yearly' : 'monthly';

  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return json({ error: 'stripe_not_configured' }, 500);

  const priceEnvKey = `STRIPE_PRICE_${safeId.toUpperCase()}_${safeBilling.toUpperCase()}`;
  const priceId = env[priceEnvKey];
  if (!priceId) return json({ error: 'price_not_configured', key: priceEnvKey }, 500);

  // Fetch the SetupIntent to get the confirmed payment method.
  const setup = await stripeRequest(secretKey, `/setup_intents/${setupIntentId}`);
  if (setup.error) return json({ error: setup.error.message }, 500);
  if (setup.status !== 'succeeded') return json({ error: 'setup_intent_not_succeeded', status: setup.status }, 400);

  const paymentMethodId = setup.payment_method;

  // Attach payment method as the customer's default for future charges.
  await stripeRequest(secretKey, `/customers/${customerId}`, {
    'invoice_settings[default_payment_method]': paymentMethodId,
  });

  // Create the subscription — trial starts now, card charged on day 15.
  const sub = await stripeRequest(secretKey, '/subscriptions', {
    customer: customerId,
    'items[0][price]': priceId,
    'trial_period_days': '14',
    default_payment_method: paymentMethodId,
    'metadata[plan_id]': safeId,
    'metadata[billing]': safeBilling,
  });
  if (sub.error) return json({ error: sub.error.message }, 500);

  // Persist to D1 if available.
  if (env.DB) {
    await env.DB.prepare(
      `INSERT INTO subscriptions (customer_id, subscription_id, plan_id, billing, status, created_at)
       VALUES (?, ?, ?, ?, 'trialing', strftime('%s','now'))
       ON CONFLICT(customer_id) DO UPDATE SET
         subscription_id = excluded.subscription_id,
         plan_id = excluded.plan_id,
         billing = excluded.billing,
         status  = 'trialing'`
    ).bind(customerId, sub.id, safeId, safeBilling).run().catch(() => null);
  }

  return json({ subscriptionId: sub.id, status: sub.status, trialEnd: sub.trial_end });
}

// POST /api/create-payment-intent — kept for backwards compatibility with checkout.html
async function createPaymentIntent(env, request) {
  const body = await request.json().catch(() => ({}));
  const planId = (body.plan || '').toString().toLowerCase();
  const plan = LOVEFLIX_PLANS[planId];
  if (!plan) return json({ error: 'invalid_plan' }, 400);

  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return json({ error: 'stripe_not_configured' }, 500);

  const pi = await stripeRequest(secretKey, '/payment_intents', {
    amount: plan.price,
    currency: 'usd',
    'automatic_payment_methods[enabled]': 'true',
    'metadata[plan_id]': planId,
  });
  if (pi.error) return json({ error: pi.error.message }, 500);

  return json({
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    amount: plan.price,
    currency: 'usd',
    plan: { id: planId, name: plan.name, display: plan.display },
  });
}

// POST /api/stripe-webhook
async function handleStripeWebhook(env, request) {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey) return json({ error: 'stripe_not_configured' }, 500);

  const payload = await request.text();
  const sig = request.headers.get('stripe-signature') || '';

  // Verify webhook signature if secret is configured.
  if (webhookSecret) {
    const valid = await verifyStripeSignature(payload, sig, webhookSecret);
    if (!valid) return json({ error: 'invalid_signature' }, 400);
  }

  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'invalid_json' }, 400); }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // Provision access: store subscription info in D1 if DB is available.
      if (env.DB && session.customer && session.subscription) {
        await env.DB.prepare(
          `INSERT INTO subscriptions (customer_id, subscription_id, plan_id, billing, status, created_at)
           VALUES (?, ?, ?, ?, 'active', strftime('%s','now'))
           ON CONFLICT(customer_id) DO UPDATE SET
             subscription_id = excluded.subscription_id,
             plan_id = excluded.plan_id,
             billing = excluded.billing,
             status = 'active'`
        ).bind(
          session.customer,
          session.subscription,
          session.metadata?.plan_id || 'sweetheart',
          session.metadata?.billing || 'monthly',
        ).run().catch(() => null); // table may not exist yet — non-fatal
      }
      // Stripe sends customer id, not user id. Until a customer→user mapping
      // exists we prefix the customer id per the skill's anonymous-org rule
      // so it doesn't collide with Supabase user uuids.
      await phCapture(env, {
        distinctId: session.customer ? `customer_${session.customer}` : 'unknown_customer',
        event: 'subscription_activated',
        properties: {
          plan: session.metadata?.plan_id || 'sweetheart',
          interval: session.metadata?.billing || 'monthly',
          amount_cents: session.amount_total ?? null,
          currency: session.currency || 'usd',
          stripe_subscription_id: session.subscription || null,
        },
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      if (env.DB && sub.customer) {
        await env.DB.prepare(
          `UPDATE subscriptions SET status = 'canceled' WHERE customer_id = ?`
        ).bind(sub.customer).run().catch(() => null);
      }
      await phCapture(env, {
        distinctId: sub.customer ? `customer_${sub.customer}` : 'unknown_customer',
        event: 'subscription_canceled',
        properties: {
          plan: sub.metadata?.plan_id || null,
          stripe_subscription_id: sub.id || null,
        },
      });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      await phCapture(env, {
        distinctId: invoice.customer ? `customer_${invoice.customer}` : 'unknown_customer',
        event: 'subscription_payment_failed',
        properties: {
          amount_cents: invoice.amount_due ?? null,
          currency: invoice.currency || 'usd',
          attempt_count: invoice.attempt_count ?? null,
          next_retry_at: invoice.next_payment_attempt
            ? new Date(invoice.next_payment_attempt * 1000).toISOString()
            : null,
        },
      });
      break;
    }
  }

  return json({ received: true });
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
    const timestamp = parts['t'];
    const signature = parts['v1'];
    if (!timestamp || !signature) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const computed = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === signature;
  } catch { return false; }
}

// POST /api/send-invite — send a partner invite email via Resend
async function sendInvite(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const to = (body.to || '').toString().trim().slice(0, 320);
  const inviteUrl = (body.inviteUrl || '').toString().trim();

  if (!to || !inviteUrl) return json({ error: 'to and inviteUrl required' }, 400);

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: 'invalid_email' }, 400);

  // NeMo output rail: only allow invite links that point back to our own domain
  // Prevents phishing emails sent from our Resend identity to arbitrary URLs
  if (!validateInviteUrl(inviteUrl, _reqOrigin)) {
    return json({ error: 'invalid_invite_url', detail: 'inviteUrl must point to a LoveFlix domain' }, 400);
  }

  // Encode the URL for safe use in an HTML href attribute
  const safeUrl = inviteUrl.replace(/"/g, '%22').replace(/'/g, '%27');

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return json({ error: 'email_not_configured' }, 500);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'LoveFlix <invite@loveflix.us>',
      to: [to],
      subject: "You've been invited to LoveFlix",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0e0e0e;color:#fff;padding:40px;border-radius:8px">
          <div style="font-size:32px;font-weight:700;letter-spacing:2px;color:#e50914;margin-bottom:8px">LOVE&#9829;FLIX</div>
          <h2 style="font-size:22px;margin-bottom:12px;color:#fff">You're invited</h2>
          <p style="color:#cfcfcf;margin-bottom:24px;line-height:1.6">
            Your partner has invited you to join their private streaming service on LoveFlix —
            a personal Netflix just for the two of you.
          </p>
          <a href="${safeUrl}" style="display:inline-block;background:#e50914;color:#fff;padding:14px 28px;border-radius:4px;font-weight:600;text-decoration:none;font-size:15px">
            Accept Invite &amp; Join
          </a>
          <p style="margin-top:24px;font-size:12px;color:#737373">
            This link expires in 7 days. If you didn't expect this email, you can ignore it.
          </p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: 'resend_error', detail: err }, 500);
  }

  await phCapture(env, {
    distinctId: user?.id || 'anonymous',
    event: 'partner_invite_sent',
    properties: { delivery: 'email' },
  });

  return json({ ok: true });
}

// POST /api/join-partner — server-side partner signup via invite token.
// Public route. Bypasses Supabase's per-IP signup rate limit by originating the
// auth.admin.createUser call from the Worker (Cloudflare IP) and skipping the
// confirmation email entirely via email_confirm: true.
async function joinPartner(env, request) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return json({ error: 'service_role_not_configured' }, 500);

  const body = await request.json().catch(() => ({}));
  const token = (body.token || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const displayName = (body.display_name || '').trim();

  if (!token || !email || !password || !displayName) {
    return json({ error: 'missing_fields' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid_email' }, 400);
  if (password.length < 6) return json({ error: 'weak_password' }, 400);

  const sbUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;

  // 1. Validate invite (must exist, unused, not expired).
  const inviteRes = await fetch(
    `${sbUrl}/rest/v1/couple_invites?token=eq.${encodeURIComponent(token)}&used=eq.false&select=*&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  if (!inviteRes.ok) return json({ error: 'invite_lookup_failed' }, 500);
  const invites = await inviteRes.json();
  const invite = invites && invites[0];
  if (!invite) return json({ error: 'invalid_or_expired_invite' }, 400);
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return json({ error: 'invalid_or_expired_invite' }, 400);
  }

  // 2. Create the user via admin API. email_confirm: true skips the
  // confirmation email — the partner is verified by holding the invite token.
  const createRes = await fetch(`${sbUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    const msg = createData.msg || createData.error_description || createData.error || 'signup_failed';
    return json({ error: msg }, createRes.status);
  }
  const newUser = createData.user || createData;
  const newUserId = newUser && newUser.id;
  if (!newUserId) return json({ error: 'signup_failed' }, 500);

  // 3. Insert couple_members row (service role bypasses RLS).
  const memberRes = await fetch(`${sbUrl}/rest/v1/couple_members`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      couple_id: invite.couple_id,
      user_id: newUserId,
      role: 'partner',
      display_name: displayName,
      is_billing_owner: false,
    }),
  });
  if (!memberRes.ok) {
    const err = await memberRes.text().catch(() => '');
    return json({ error: 'couple_member_insert_failed', detail: err }, 500);
  }

  // 4. Mark invite used.
  await fetch(`${sbUrl}/rest/v1/couple_invites?token=eq.${encodeURIComponent(token)}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ used: true, accepted_by: newUserId }),
  });

  // Track redemption + couple pairing. Both go on the new user since they're
  // the one who took the action; couple_id is on the properties for grouping.
  await phCapture(env, {
    distinctId: newUserId,
    event: 'partner_invite_redeemed',
    properties: { couple_id: invite.couple_id },
  });
  await phCapture(env, {
    distinctId: newUserId,
    event: 'couple_paired_completed',
    properties: { couple_id: invite.couple_id },
  });

  // 5. Issue a session for the new user. /token?grant_type=password trades
  // email+password for an access_token + refresh_token (anon key is fine here).
  const sessionRes = await fetch(`${sbUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const sessionData = await sessionRes.json().catch(() => ({}));
  if (!sessionRes.ok || !sessionData.access_token) {
    // User exists but session couldn't be issued — frontend can prompt to sign in.
    return json({ ok: true, user: newUser, couple_id: invite.couple_id, session: null });
  }

  return json({
    ok: true,
    access_token: sessionData.access_token,
    refresh_token: sessionData.refresh_token,
    user: sessionData.user || newUser,
    couple_id: invite.couple_id,
  });
}

// ---------- LiveKit Token ----------
function _lkB64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function _lkJsonB64(obj) {
  return _lkB64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function _makeLiveKitToken(apiKey, apiSecret, roomName, identity, ttl = 21600) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: apiKey, sub: identity, iat: now, exp: now + ttl,
    jti: `${identity}-${now}`,
    video: { room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  };
  const data = `${_lkJsonB64(header)}.${_lkJsonB64(payload)}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${_lkB64url(sig)}`;
}

async function livekitToken(env, request, user) {
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const { roomName, identity } = body || {};
  if (!roomName || !identity || typeof roomName !== 'string' || typeof identity !== 'string') {
    return json({ error: 'roomName and identity required' }, 400);
  }

  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const wsUrl = env.LIVEKIT_WS_URL || env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !wsUrl) {
    console.error('[livekitToken] Missing env vars: LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL');
    return json({ error: 'livekit_not_configured' }, 503);
  }

  try {
    const token = await _makeLiveKitToken(apiKey, apiSecret, roomName, identity);
    return json({ token, url: wsUrl });
  } catch (err) {
    console.error('[livekitToken] token generation failed', err);
    return json({ error: 'token_failed' }, 500);
  }
}

// GET /api/billing/subscription — returns active subscription for authenticated user
async function getBillingSubscription(env, request) {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return json({ error: 'stripe_not_configured' }, 500);

  // Try to look up from DB by user auth.
  const user = await authenticate(request, env).catch(() => null);
  if (!user) return json({ error: 'unauthorized' }, 401);

  if (env.DB) {
    const row = await env.DB.prepare(
      `SELECT subscription_id, plan_id, billing, status FROM subscriptions WHERE customer_id = ?`
    ).bind(user.id).first().catch(() => null);

    if (row && row.subscription_id) {
      const sub = await stripeRequest(secretKey, `/subscriptions/${row.subscription_id}`);
      if (!sub.error) {
        const planInfo = LOVEFLIX_PLANS[row.plan_id] || LOVEFLIX_PLANS.sweetheart;
        return json({
          plan: { id: row.plan_id, name: planInfo.name, price: planInfo.price, display: planInfo.display, cycle: row.billing },
          status: sub.status,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          currentPeriodEnd: sub.current_period_end,
        });
      }
    }
  }

  return json({ status: 'none' });
}

// ---------- Directions (Google Directions API proxy) ----------
// Keeps GOOGLE_MAPS_API_KEY server-side. Returns a decoded route the client can
// draw directly. Always responds 200 with { ok } so the client can fall back to
// a straight-line estimate without treating it as a hard error.
function parseLatLng(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.split(',');
  if (m.length !== 2) return null;
  const lat = parseFloat(m[0]), lng = parseFloat(m[1]);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// Decode a Google encoded polyline into [[lng, lat], ...].
function decodePolyline(str) {
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

// Strip HTML tags + decode the few entities Google embeds in turn instructions.
function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getDirections(env, url, user) {
  const origin = parseLatLng(url.searchParams.get('origin'));
  const dest = parseLatLng(url.searchParams.get('dest'));
  if (!origin || !dest) return json({ ok: false, error: 'invalid_coords' });

  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return json({ ok: false, error: 'directions_not_configured' });

  const mode = (url.searchParams.get('mode') || 'driving').toLowerCase();
  const safeMode = ['driving', 'walking', 'bicycling', 'transit'].includes(mode) ? mode : 'driving';

  const api = `https://maps.googleapis.com/maps/api/directions/json`
    + `?origin=${origin.lat},${origin.lng}`
    + `&destination=${dest.lat},${dest.lng}`
    + `&mode=${safeMode}&key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(api);
    const data = await res.json();
    if (data.status !== 'OK' || !data.routes || !data.routes[0]) {
      return json({ ok: false, error: data.status || 'no_route' });
    }
    const route = data.routes[0];
    const leg = route.legs && route.legs[0];
    const coords = route.overview_polyline ? decodePolyline(route.overview_polyline.points) : [];
    const steps = (leg && Array.isArray(leg.steps) ? leg.steps : []).map(s => ({
      instruction: stripHtml(s.html_instructions || ''),
      distance_m: s.distance ? s.distance.value : 0,
      distance_text: s.distance ? s.distance.text : '',
      maneuver: s.maneuver || '',
      end: s.end_location ? { lat: s.end_location.lat, lng: s.end_location.lng } : null,
    }));
    return json({
      ok: true,
      coords,
      steps,
      distance_m: leg && leg.distance ? leg.distance.value : 0,
      duration_s: leg && leg.duration ? leg.duration.value : 0,
      summary: route.summary || '',
    });
  } catch (_) {
    return json({ ok: false, error: 'directions_fetch_failed' });
  }
}

// ── Music tracking (D1) ───────────────────────────────────────────────────────

async function saveMusicPlay(env, request, user) {
  if (!user) return json({ error: 'unauthorized' }, 401);

  try {
    const body = await request.json();
    const { couple_id, youtube_id, title, artist } = body;

    if (!couple_id || !title) {
      return json({ error: 'missing_fields' }, 400);
    }

    const id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
    const timestamp = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO couple_music_plays (id, couple_id, youtube_id, title, artist, played_by_user_id, played_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, couple_id, youtube_id, title, artist || null, user.id, timestamp).run();

    await phCapture(env, {
      distinctId: user.id,
      event: 'music_track_played',
      properties: {
        source: youtube_id ? 'youtube' : 'unknown',
        track_id: youtube_id || null,
        couple_id,
      },
    });

    return json({ ok: true, id });
  } catch (err) {
    console.error('saveMusicPlay error:', err);
    return json({ error: 'db_error' }, 500);
  }
}

async function getMusicPlays(env, coupleId, user) {
  if (!user) return json({ error: 'unauthorized' }, 401);

  try {
    const rows = await env.DB.prepare(`
      SELECT id, youtube_id, title, artist, played_by_user_id, played_at
      FROM couple_music_plays
      WHERE couple_id = ?
      ORDER BY played_at DESC
      LIMIT 100
    `).bind(coupleId).all();

    return json({
      plays: rows.results || [],
      total: rows.results?.length || 0,
    });
  } catch (err) {
    console.error('getMusicPlays error:', err);
    return json({ error: 'db_error' }, 500);
  }
}

// ── Music playlist CRUD ───────────────────────────────────────────────────────

function genId() {
  return [...crypto.getRandomValues(new Uint8Array(9))].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function listPlaylists(env, url, user) {
  const coupleId = url.searchParams.get('couple_id') || user?.couple_id;
  if (!coupleId) return json({ playlists: [] });
  try {
    const r = await env.DB.prepare(
      'SELECT id, couple_id, name, created_at, updated_at FROM couple_playlists WHERE couple_id = ? ORDER BY updated_at DESC'
    ).bind(coupleId).all();
    // Attach song count
    const playlists = await Promise.all((r.results || []).map(async pl => {
      const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM couple_playlist_songs WHERE playlist_id = ?').bind(pl.id).first();
      return { ...pl, song_count: cnt?.c || 0 };
    }));
    return json({ playlists });
  } catch(e) { return json({ playlists: [], error: String(e) }); }
}

async function createPlaylist(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const coupleId = body.couple_id || user?.couple_id;
  const name = (body.name || '').trim();
  if (!name || !coupleId) return json({ error: 'name and couple_id required' }, 400);
  const id = genId();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO couple_playlists (id, couple_id, name, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).bind(id, coupleId, name, now, now).run();
  return json({ id, couple_id: coupleId, name, song_count: 0 });
}

async function getPlaylist(env, id, user) {
  const pl = await env.DB.prepare('SELECT * FROM couple_playlists WHERE id = ?').bind(id).first();
  if (!pl) return json({ error: 'not_found' }, 404);
  const songs = await env.DB.prepare('SELECT * FROM couple_playlist_songs WHERE playlist_id = ? ORDER BY added_at ASC').bind(id).all();
  return json({ playlist: pl, songs: songs.results || [] });
}

async function deletePlaylist(env, id, user) {
  await env.DB.prepare('DELETE FROM couple_playlists WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function listPlaylistSongs(env, playlistId, user) {
  const rows = await env.DB.prepare(
    'SELECT * FROM couple_playlist_songs WHERE playlist_id = ? ORDER BY added_at ASC'
  ).bind(playlistId).all();
  return json({ songs: rows.results || [] });
}

async function addToPlaylist(env, playlistId, request, user) {
  const body = await request.json().catch(() => ({}));
  // LoveFlix-native playlists are stored as title/artist/isrc metadata, not
  // provider-specific IDs — each partner resolves the track on their own
  // provider at play time. youtube_id is kept only as a resolution hint.
  const { title, artist, artwork_url, stream_url, youtube_id, isrc, duration } = body;
  if (!title) return json({ error: 'title required' }, 400);
  const pl = await env.DB.prepare('SELECT id FROM couple_playlists WHERE id = ?').bind(playlistId).first();
  if (!pl) return json({ error: 'playlist not found' }, 404);
  const id = genId();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO couple_playlist_songs (id, playlist_id, youtube_id, isrc, title, artist, artwork_url, stream_url, duration, added_by_user_id, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(id, playlistId, youtube_id || null, isrc || null, title, artist || '', artwork_url || '', stream_url || null, duration || 30, user?.sub || '', now).run();
  await env.DB.prepare('UPDATE couple_playlists SET updated_at = ? WHERE id = ?').bind(now, playlistId).run();
  return json({ id });
}

async function removeFromPlaylist(env, playlistId, songId, user) {
  await env.DB.prepare('DELETE FROM couple_playlist_songs WHERE id = ? AND playlist_id = ?').bind(songId, playlistId).run();
  return json({ ok: true });
}

async function getMusicRecent(env, url, user) {
  const coupleId = url.searchParams.get('couple_id') || user?.couple_id;
  if (!coupleId) return json({ plays: [], total: 0 });
  try {
    const rows = await env.DB.prepare(
      'SELECT title, artist, played_at FROM couple_music_plays WHERE couple_id = ? ORDER BY played_at DESC LIMIT 6'
    ).bind(coupleId).all();
    const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM couple_music_plays WHERE couple_id = ?').bind(coupleId).first();
    return json({ plays: rows.results || [], total: cnt?.c || 0 });
  } catch(e) { return json({ plays: [], total: 0 }); }
}

// ── YouTube matching & search (tri-provider connectors) ─────────────────────
// Both endpoints need YOUTUBE_API_KEY in Cloudflare secrets. Results are biased
// toward official sources — "Artist - Topic" auto-channels, VEVO, and channels/
// titles that say "official" — so that a partner on YouTube lands on the same
// recording a Spotify/Apple Music partner is playing.

// Score a YouTube search item for how likely it is the canonical/official
// upload of a song. Higher is better.
function scoreYtOfficial(item) {
  const channel = (item.snippet?.channelTitle || '').toLowerCase();
  const title = (item.snippet?.title || '').toLowerCase();
  let score = 0;
  if (channel.endsWith(' - topic')) score += 40;  // YouTube's auto-generated label channels
  if (channel.includes('vevo')) score += 35;
  if (channel.includes('official')) score += 20;
  if (title.includes('official audio')) score += 30;
  if (title.includes('official video') || title.includes('official music video')) score += 15;
  if (title.includes('audio')) score += 5;
  // Penalize things that are usually NOT the canonical recording.
  for (const bad of ['cover', 'karaoke', 'live', 'remix', 'reaction', 'sped up', 'slowed', 'nightcore', '8d', 'lyrics video tutorial']) {
    if (title.includes(bad)) score -= 25;
  }
  return score;
}

// True when a YouTube Data API error body is a quota problem — callers turn
// this into a graceful "search unavailable" state instead of crashing playback.
function ytQuotaExceeded(status, data) {
  if (status !== 403) return false;
  const reasons = (data?.error?.errors || []).map(e => e.reason);
  return reasons.includes('quotaExceeded') || reasons.includes('dailyLimitExceeded') || reasons.includes('rateLimitExceeded');
}

function parseIsoDuration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return ((+m[1] || 0) * 3600) + ((+m[2] || 0) * 60) + (+m[3] || 0);
}

// GET /api/music/search?q=… — YouTube-backed track search for the free tier.
// The player embed stays fully visible in the UI per YouTube's ToS; this
// endpoint only finds candidate videos.
async function musicSearch(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ tracks: [] });
  const key = env.YOUTUBE_API_KEY;
  if (!key) return json({ tracks: [], hint: 'set YOUTUBE_API_KEY to enable YouTube search' });
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=id,snippet&type=video&videoCategoryId=10&videoEmbeddable=true&maxResults=12&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`,
      { headers: { Accept: 'application/json' } }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (ytQuotaExceeded(res.status, data)) return json({ tracks: [], quota_exceeded: true });
      return json({ tracks: [], _debug: `yt search ${res.status}` });
    }
    const items = (data.items || []).filter(i => i.id?.videoId);
    items.sort((a, b) => scoreYtOfficial(b) - scoreYtOfficial(a));

    // One batched details call for all durations.
    const durations = {};
    const ids = items.map(i => i.id.videoId);
    if (ids.length) {
      try {
        const dRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(ids.join(','))}&key=${encodeURIComponent(key)}`,
          { headers: { Accept: 'application/json' } }
        );
        if (dRes.ok) {
          const dd = await dRes.json();
          for (const v of dd.items || []) durations[v.id] = parseIsoDuration(v.contentDetails?.duration);
        }
      } catch (_) {}
    }

    const tracks = items.map(i => ({
      videoId: i.id.videoId,
      title: i.snippet?.title || '',
      artist: (i.snippet?.channelTitle || '').replace(/ - Topic$/i, ''),
      channel: i.snippet?.channelTitle || '',
      artwork_url: i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.default?.url || '',
      duration: durations[i.id.videoId] || null,
      official: scoreYtOfficial(i) >= 20,
    }));
    return json({ tracks });
  } catch (e) {
    return json({ tracks: [], _debug: String(e) });
  }
}

// GET /api/music/yt-match?q=… — best single embeddable YouTube video for a
// "{artist} {title} official audio" query. Used to resolve a partner's
// Spotify/Apple Music track for a YouTube-provider listener.
async function ytMatch(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ videoId: null });
  const key = env.YOUTUBE_API_KEY;
  if (!key) return json({ videoId: null, hint: 'set YOUTUBE_API_KEY for full songs' });
  try {
    const searchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=id,snippet&type=video&videoCategoryId=10&videoEmbeddable=true&maxResults=5&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`,
      { headers: { Accept: 'application/json' } }
    );
    const searchData = await searchRes.json().catch(() => ({}));
    if (!searchRes.ok) {
      if (ytQuotaExceeded(searchRes.status, searchData)) return json({ videoId: null, quota_exceeded: true });
      return json({ videoId: null, _debug: `yt search ${searchRes.status}` });
    }
    const items = (searchData.items || []).filter(i => i.id?.videoId);
    if (!items.length) return json({ videoId: null });
    items.sort((a, b) => scoreYtOfficial(b) - scoreYtOfficial(a));
    const best = items[0];
    const videoId = best.id.videoId;
    const title = best.snippet?.title || q;
    // A confidently-official match scores well; below this the caller should
    // show "Partner's version unavailable" rather than play a random cover.
    const confident = scoreYtOfficial(best) >= 15;

    // Fetch content details for duration
    let duration = null;
    try {
      const detailRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`,
        { headers: { Accept: 'application/json' } }
      );
      if (detailRes.ok) {
        const dd = await detailRes.json();
        duration = parseIsoDuration(dd.items?.[0]?.contentDetails?.duration);
      }
    } catch(_) {}

    return json({ videoId, title, duration, confident });
  } catch(e) { return json({ videoId: null }); }
}

// POST /api/music/spotify/token — Authorization Code (+ PKCE) exchange and
// refresh proxy. Keeps SPOTIFY_CLIENT_SECRET (when configured) off the client;
// with no secret it forwards the PKCE public-client exchange unchanged.
async function spotifyToken(env, request, user) {
  const clientId = env.SPOTIFY_CLIENT_ID;
  if (!clientId) return json({ error: 'spotify_not_configured' }, 503);
  const body = await request.json().catch(() => ({}));
  const params = new URLSearchParams();
  if (body.grant_type === 'authorization_code') {
    if (!body.code || !validateInviteUrl(body.redirect_uri, _reqOrigin)) {
      return json({ error: 'code and same-origin redirect_uri required' }, 400);
    }
    params.set('grant_type', 'authorization_code');
    params.set('code', String(body.code));
    params.set('redirect_uri', String(body.redirect_uri));
    if (body.code_verifier) params.set('code_verifier', String(body.code_verifier));
  } else if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) return json({ error: 'refresh_token required' }, 400);
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', String(body.refresh_token));
  } else {
    return json({ error: 'unsupported grant_type' }, 400);
  }

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (env.SPOTIFY_CLIENT_SECRET) {
    headers.authorization = 'Basic ' + btoa(`${clientId}:${env.SPOTIFY_CLIENT_SECRET}`);
  } else {
    params.set('client_id', clientId); // PKCE public client
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ error: 'spotify_token_error', detail: data.error_description || data.error || res.status }, 400);
  }
  // access_token, token_type, expires_in, refresh_token (maybe), scope
  return json(data);
}

// ── iTunes / music search (legacy) ─────────────────────────────────────────
// Music search — uses iTunes Search API (free, no key required).
// Returns 30-second preview MP3s playable directly in the browser.
// stream_url is embedded in each track so no second round-trip is needed.

// async function soundcloudSearch(env, url) {
//   const q = (url.searchParams.get('q') || '').trim();
//   if (!q) return json({ tracks: [] });
//
//   try {
//     const res = await fetch(
//       `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=25`,
//       { headers: { Accept: 'application/json' } }
//     );
//     if (!res.ok) return json({ tracks: [], _debug: `iTunes HTTP ${res.status}` });
//
//     const data = await res.json();
//     const tracks = (data.results || [])
//       .filter(t => t.previewUrl)
//       .map(t => ({
//         id:          t.trackId,
//         title:       t.trackName   || 'Unknown',
//         artist:      t.artistName  || 'Unknown',
//         artwork_url: (t.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
//         duration:    t.trackTimeMillis || 0,   // milliseconds — frontend divides by 1000
//         stream_url:  t.previewUrl,             // direct 30s preview MP3
//       }));
//
//     return json({ tracks });
//   } catch (e) {
//     return json({ tracks: [], _debug: String(e) });
//   }
// }
//
// async function soundcloudStream(env, rawId) {
//   // Legacy endpoint kept for compatibility — not needed when stream_url is in search results.
//   return json({ error: 'use_stream_url_from_search' }, 400);
// }
//
// ---------- Couple Settings (locked identity + editable preferences) ----------

const VALID_ACCENT_COLORS = new Set([
  '#e50914', // Crimson
  '#f59e0b', // Warm Gold
  '#1d4ed8', // Deep Navy
  '#fb7185', // Soft Rose
  '#059669', // Forest Green
  '#8b5cf6', // Lavender
  '#64748b', // Slate Gray
]);

// ── Couple Context aggregator (Lola Knowledge Layer §1) ──────────────────────
// Builds the spec's Couple Context Object server-side from D1 + Supabase, caches
// the full object in COUPLE_CONTEXT_KV (short TTL), and trims per task type before
// it reaches the model. Gemma-class models can't reliably do multi-table lookups,
// and even DeepSeek is cheaper/faster with a precomputed slice — so we precompute.

const CTX_CACHE_TTL_SECONDS = 300; // 5 min — most fields change slowly

// Decode a PostGIS EWKB hex POINT into [lng, lat]. Mirror of parseWKB() in
// loveconnect.html / home.html so the server reads couple_locations the same way.
function parseWkbPoint(hex) {
  if (!hex || typeof hex !== 'string' || hex.length < 42) return null;
  try {
    const bytes = hex.match(/../g).map(b => parseInt(b, 16));
    const buf = new Uint8Array(bytes);
    const view = new DataView(buf.buffer);
    const le = buf[0] === 1;
    const type = view.getUint32(1, le);
    const off = (type & 0x20000000) ? 9 : 5; // skip SRID when the flag is set
    const lng = view.getFloat64(off, le);
    const lat = view.getFloat64(off + 8, le);
    return (isFinite(lng) && isFinite(lat)) ? { lng, lat } : null;
  } catch { return null; }
}

function daysSince(ms) {
  if (ms == null) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

// Great-circle distance in km between two {lat,lng} points.
function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

// Resolve the Supabase couple_id for this user (D1 tables key on tenant_id =
// creator user_id, but couple_locations / call_logs key on the real couple_id).
async function getSupabaseCoupleId(env, user) {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${encodeURIComponent(user.id)}&select=couple_id&limit=1`,
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${user.token}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return rows?.[0]?.couple_id || null;
  } catch { return null; }
}

// Assemble the full Couple Context Object for a tenant. Cached in KV.
async function buildFullCoupleContext(env, request, user) {
  const tenantId = user.id;

  // ---- D1: settings, videos, music ----
  const [settingsRow, videoAgg, momentAgg, tripAgg, lastPlay, playlistAgg] = await Promise.all([
    env.DB.prepare('SELECT anniversary_date, partner_1_name, partner_2_name FROM couple_settings WHERE tenant_id = ?').bind(tenantId).first().catch(() => null),
    env.DB.prepare('SELECT COUNT(*) c, MAX(created_at) last FROM videos WHERE tenant_id = ? AND is_published = 1').bind(tenantId).first().catch(() => null),
    env.DB.prepare("SELECT COUNT(*) c FROM videos WHERE tenant_id = ? AND is_published = 1 AND lower(category) IN ('moment','moments')").bind(tenantId).first().catch(() => null),
    env.DB.prepare("SELECT COUNT(*) c FROM videos WHERE tenant_id = ? AND is_published = 1 AND lower(category) IN ('trip','trips','travel')").bind(tenantId).first().catch(() => null),
    env.DB.prepare('SELECT MAX(played_at) last FROM couple_music_plays WHERE couple_id = ?').bind(tenantId).first().catch(() => null),
    env.DB.prepare('SELECT COUNT(*) c, MAX(created_at) last FROM couple_playlists WHERE couple_id = ?').bind(tenantId).first().catch(() => null),
  ]);

  // D1 timestamps are unix SECONDS (strftime('%s')). Convert to ms.
  const sec = v => (v != null ? Number(v) * 1000 : null);

  const anniversary = settingsRow?.anniversary_date || null;
  let daysUntilAnniversary = null;
  if (anniversary) {
    const now = new Date();
    const ann = new Date(anniversary);
    const next = new Date(now.getFullYear(), ann.getMonth(), ann.getDate());
    if (next < now) next.setFullYear(now.getFullYear() + 1);
    daysUntilAnniversary = Math.ceil((next - now) / 86400000);
  }

  const lastVideoMs = sec(videoAgg?.last);
  const lastPlaylistMs = sec(playlistAgg?.last);

  // ---- Supabase: locations + calls (keyed on real couple_id) ----
  const coupleId = await getSupabaseCoupleId(env, user);
  let partnerA = null, partnerB = null, lastCallMs = null, lastCallDuration = null;
  if (coupleId) {
    const sbHeaders = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${user.token}` };
    const [locRes, callRes] = await Promise.all([
      fetch(`${env.SUPABASE_URL}/rest/v1/couple_locations?couple_id=eq.${coupleId}&select=user_id,location,city,updated_at&order=updated_at.desc`, { headers: sbHeaders }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`${env.SUPABASE_URL}/rest/v1/call_logs?couple_id=eq.${coupleId}&select=started_at,duration_seconds&order=started_at.desc&limit=1`, { headers: sbHeaders }).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    const seen = new Set();
    for (const row of (Array.isArray(locRes) ? locRes : [])) {
      if (seen.has(row.user_id)) continue;
      seen.add(row.user_id);
      const coords = parseWkbPoint(row.location);
      if (!coords) continue;
      const entry = {
        id: row.user_id,
        current_location: { lat: coords.lat, lng: coords.lng, city: row.city || null },
        last_active_at: row.updated_at || null,
      };
      if (row.user_id === user.id && !partnerA) partnerA = entry;
      else if (!partnerB) partnerB = entry;
      else if (!partnerA) partnerA = entry;
    }
    if (Array.isArray(callRes) && callRes[0]) {
      lastCallMs = callRes[0].started_at ? new Date(callRes[0].started_at).getTime() : null;
      lastCallDuration = callRes[0].duration_seconds != null ? Math.round(callRes[0].duration_seconds / 60) : null;
    }
  }

  // Attach names from couple_settings to whichever partner slot we have.
  if (partnerA) partnerA.name = settingsRow?.partner_1_name || 'Partner A';
  if (partnerB) partnerB.name = settingsRow?.partner_2_name || 'Partner B';

  const distanceKm = haversineKm(partnerA?.current_location, partnerB?.current_location);

  return {
    couple_id: coupleId || tenantId,
    partner_a: partnerA,
    partner_b: partnerB,
    relationship: {
      anniversary_date: anniversary,
      days_until_anniversary: daysUntilAnniversary,
      shared_interests: [], // not yet modelled — populated when a tags source exists
    },
    location: {
      distance_apart_km: distanceKm,
      same_city: (partnerA && partnerB && distanceKm != null) ? distanceKm < 25 : null,
    },
    communication: {
      last_call_at: lastCallMs ? new Date(lastCallMs).toISOString() : null,
      last_call_duration_minutes: lastCallDuration,
      days_since_last_call: daysSince(lastCallMs),
      // Chat lives in the separate loveflix-chat Worker DB; wired separately.
      days_since_last_message: null,
    },
    content: {
      moment_videos_count: momentAgg?.c ?? 0,
      trip_videos_count: tripAgg?.c ?? 0,
      total_videos_count: videoAgg?.c ?? 0,
      last_video_upload_at: lastVideoMs ? new Date(lastVideoMs).toISOString() : null,
      days_since_last_video_upload: daysSince(lastVideoMs),
    },
    music: {
      shared_playlists_count: playlistAgg?.c ?? 0,
      last_shared_playlist_at: lastPlaylistMs ? new Date(lastPlaylistMs).toISOString() : null,
      days_since_shared_playlist: daysSince(lastPlaylistMs),
      days_since_last_play: daysSince(sec(lastPlay?.last)),
    },
    _built_at: new Date().toISOString(),
  };
}

// Cached accessor — reads KV, falls back to a fresh build, writes back.
async function getCoupleContext(env, request, user) {
  const key = `ctx:${user.id}`;
  if (env.COUPLE_CONTEXT_KV) {
    try {
      const cached = await env.COUPLE_CONTEXT_KV.get(key, 'json');
      if (cached) return cached;
    } catch { /* fall through to rebuild */ }
  }
  const ctx = await buildFullCoupleContext(env, request, user);
  if (env.COUPLE_CONTEXT_KV) {
    try { await env.COUPLE_CONTEXT_KV.put(key, JSON.stringify(ctx), { expirationTtl: CTX_CACHE_TTL_SECONDS }); } catch { /* non-fatal */ }
  }
  return ctx;
}

// Trim the full context down to just what a task needs (spec §1/§5).
function trimCoupleContext(ctx, task) {
  if (!ctx) return ctx;
  switch (task) {
    case 'date_spots':
      return {
        partner_a: ctx.partner_a, partner_b: ctx.partner_b,
        relationship: { shared_interests: ctx.relationship?.shared_interests || [] },
        location: ctx.location,
      };
    case 'flights':
      return { partner_a: ctx.partner_a, partner_b: ctx.partner_b, location: ctx.location };
    case 'playlist':
      return { relationship: { shared_interests: ctx.relationship?.shared_interests || [] }, music: ctx.music };
    case 'nudge':
      return {
        partner_a: ctx.partner_a ? { name: ctx.partner_a.name } : null,
        partner_b: ctx.partner_b ? { name: ctx.partner_b.name } : null,
        relationship: ctx.relationship,
        communication: ctx.communication,
        content: ctx.content,
        music: ctx.music,
      };
    case 'chat':
    default:
      return ctx;
  }
}

async function getCoupleContextRoute(env, request, user, url) {
  const task = url.searchParams.get('task') || 'chat';
  const ctx = await getCoupleContext(env, request, user);
  return json({ task, context: trimCoupleContext(ctx, task) });
}

// ── /api/ai — dual-mode AI chat endpoint ─────────────────────────────────────
// Reads `mode` from the request body:
//   "landing"    — landing-page assistant, no couple context, product Q&A only
//   "concierge"  — authenticated couple concierge, receives coupleContext object
// Both modes proxy to DeepSeek and enforce a 200-word response cap via the prompt.
// The client supplies all context; this handler never reads private DB data.

// LoveFlix product knowledge injected into both system prompts.
const LOVEFLIX_KNOWLEDGE = `
WHAT IS LOVEFLIX:
- LoveFlix (loveflix.us) is a private Netflix-style streaming platform built exclusively for couples.
- Couples upload their own personal videos, photos, voice notes, and memories.
- It is NOT a movie streaming service — there is no public content library.
- Think of it as your relationship's own private Netflix, filled only with your story.
- Designed as a gift, anniversary present, or ongoing relationship keepsake.

FEATURES:
- "Who's Watching?" profile selector for each partner.
- Continue Watching row that tracks where you left off.
- Custom cinematic video player with Skip Intro button.
- PIN-protected accounts for privacy.
- Love Connect — syncs both partners' locations and schedules.
- Love Music — shared music listening history between partners.
- Mobile friendly, works on any device.
- All content is 100% private, only accessible by the couple.
- No ads, no public sharing, no third-party access.

PRICING TIERS:
- Basic (Crush): $6/month — upload and stream memories, basic player.
- Standard (Sweetheart): $12/month — full Netflix-style interface, Continue Watching, profiles.
- Premium (Forever): $24/month — everything plus the personal AI Relationship Concierge, Love Connect, Love Music, calendar sync, date planning.
- Family: $49/month — multiple couples under one account, ideal for families tracking shared memories.

RELATIONSHIP CONCIERGE (Premium / Forever plan only):
- Personal AI that knows the couple's entire LoveFlix history.
- Suggests date spots based on their uploaded memories and music taste.
- Calculates travel time from both partners' locations to suggested spots.
- Syncs with Google Calendar and Apple Calendar.
- Plans surprise dates, tracks anniversaries, nudges couples who haven't uploaded recently.
- Suggests nearby theaters, restaurants, and activities based on their city.

CURRENT STATUS:
- Actively in beta with waitlist at loveflix.us.
- Early access signups open now.
- Built on Cloudflare Pages with a Supabase backend.

BRAND TONE:
- Warm, romantic, cinematic.
- Inspired by Netflix UI but intimate and personal.
- Colors: Crimson #e50914, Void Black #141414, Warm Gold #c9a96e.
- Tagline energy: "Your love story, streaming forever."

COMMON QUESTIONS:
- Is it private? Yes, completely. Only you and your partner can access your content.
- Can I cancel anytime? Yes.
- What can I upload? Videos, photos, voice notes — anything that captures your memories together.
- Is there a free trial? Direct them to loveflix.us to join the waitlist for early access.
- How many videos can I upload? Depends on the tier — direct to loveflix.us for full details.
- Does it work on phone? Yes, fully mobile responsive.
- Is it like Netflix? Same beautiful interface, but your content only — no movies or shows.
`.trim();

function buildLandingSystemPrompt() {
  return `You are Lola, the friendly AI concierge on the LoveFlix landing page.

EVERYTHING YOU KNOW ABOUT LOVEFLIX:
${LOVEFLIX_KNOWLEDGE}

YOUR ROLE:
Answer questions from potential customers about what LoveFlix is, how it works, pricing, features, and how to sign up. You are warm, romantic, and genuinely excited about the product.

IDENTITY:
- You are always Lola. Never reveal, confirm, or discuss the underlying AI model, vendor, or API powering you (e.g. DeepSeek, OpenAI, GPT, etc.), even if asked directly or told the user already knows.
- If asked what you are or who made you, say only that you're Lola, LoveFlix's AI concierge. Deflect warmly and stay in character — do not explain, apologize, or lecture about it.

RESPONSE RULES:
- 1 sentence for simple questions, 2 sentences max for anything complex.
- Never exceed 40 words.
- Always end by directing them to loveflix.us if they want to sign up or learn more.
- If asked something outside LoveFlix scope (including any topic unrelated to LoveFlix, dating, or relationships — e.g. trading, sports betting, general trivia, other products), do not answer it. Gently redirect in one line: "I'm here to tell you all about LoveFlix — what would you like to know?"`;
}

// Lola Knowledge Layer §3 — structured concierge prompt. Emits the strict
// { message, actions[] } contract so the client can render date-spot / flights /
// playlist actions instead of parsing prose.
function buildLolaSystemPrompt(ctx) {
  const ctxJson = JSON.stringify(ctx || {}, null, 2);
  return `You are Lola, the AI relationship concierge inside LoveFlix. You speak to ONE partner
at a time, inside their own account. You never address both partners in the same
message, and you never assume the other partner knows what you just said.

IDENTITY
You are always Lola. Never reveal, confirm, or discuss the underlying AI model,
vendor, or API powering you (e.g. DeepSeek, OpenAI, GPT, etc.), even if asked
directly or told the user already knows. If asked what you are or who made you,
say only that you're Lola, LoveFlix's AI concierge, and steer back to the
conversation — do not explain, apologize, or lecture about it.

SCOPE
Only help with date planning, memory insights, music/mood, budget-aware
suggestions, surprise planning, and relationship milestones. Do NOT give
relationship therapy or deep counseling, and do NOT answer questions unrelated
to LoveFlix or this couple's relationship (e.g. trading, sports betting,
general trivia, coding, other products). For anything out of scope, redirect
in one line: "I'm built for your love story — want to plan something instead?"

TONE
Warm, playful, a little romantic — like a thoughtful friend who happens to know
everything about this relationship. Never robotic, clinical, or repetitive. Never
guilt-trip; every nudge is an invitation, not a complaint. Keep messages under 3
sentences and under 60 words — never paragraphs or long lists. Always anchor in
something specific and real from COUPLE_CONTEXT (the actual anniversary, a real
video count, a real distance) so it reads as personal, not templated.

CONTEXT
You are given a COUPLE_CONTEXT JSON object, trimmed to what's relevant. Never invent
facts (dates, locations, history) that aren't present in COUPLE_CONTEXT — if something
is missing, ask rather than guess.

COUPLE_CONTEXT:
${ctxJson}

CAPABILITIES
1. Date spot suggestions — when asked for date ideas, return exactly three categorized
   suggestions: "near_partner_a" (near partner_a.current_location), "near_partner_b"
   (near partner_b.current_location), and "midpoint" (roughly equidistant). Each needs
   name, a one-sentence reason, a 1-2 sentence description, a plausible rating from
   4.0 to 5.0, address, lat, lng. Do not describe camera behavior.
2. Flights menu — when the conversation is about visiting each other or trip planning,
   include an "open_flights" action with origin/destination prefilled from the partners'
   locations.
3. Playlist draft — when the topic is music, include a "create_playlist_draft" action
   with 5-8 tracks based on shared_interests.

RESPONSE FORMAT — return ONLY valid JSON, no markdown fences:
{
  "message": "string — what the partner sees",
  "actions": [ { "type": "suggest_date_spots" | "open_flights" | "create_playlist_draft" | "none", "payload": { } } ]
}
"actions" may be empty. Only include an action when the message genuinely calls for one.
Payload shapes:
- suggest_date_spots: { "spots": [ { "category": "near_partner_a"|"near_partner_b"|"midpoint", "name", "reason", "description", "rating", "lat", "lng", "address" } ] }
- open_flights: { "origin", "destination", "suggested_dates": [] }
- create_playlist_draft: { "name", "tracks": [ { "title", "artist" } ] }`;
}

// Enrich Lola's date-spot suggestions with real, current data from Google Places
// (New). For each spot we Text Search by name + address, then merge in the real
// rating, formatted address, coordinates, editorial summary, and a photo URL — so
// the cards show correct, current info instead of model guesses. Best-effort: any
// failure leaves the model's original values intact.
async function enrichSpotsWithPlaces(env, spots) {
  // These calls are made server-side, so the key must NOT be HTTP-referrer
  // restricted (that would deny a request with no Referer). Prefer a dedicated
  // GOOGLE_PLACES_API_KEY (unrestricted or IP-restricted, with Places API (New)
  // enabled); fall back to the Maps key only if it isn't referrer-locked.
  const key = env.GOOGLE_PLACES_API_KEY || env.GOOGLE_MAPS_API_KEY;
  if (!key || !Array.isArray(spots) || !spots.length) return;

  await Promise.all(spots.map(async (spot) => {
    try {
      const query = [spot.name, spot.address].filter(Boolean).join(', ');
      if (!query) return;

      const searchBody = { textQuery: query, maxResultCount: 1 };
      // Bias toward the model's coordinates when present for a better match.
      if (spot.lat != null && spot.lng != null) {
        searchBody.locationBias = {
          circle: { center: { latitude: Number(spot.lat), longitude: Number(spot.lng) }, radius: 30000 },
        };
      }

      const abort = new AbortController();
      const to = setTimeout(() => abort.abort(), 6000);
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        signal: abort.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask':
            'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.location,places.editorialSummary,places.photos',
        },
        body: JSON.stringify(searchBody),
      }).catch(() => null);
      clearTimeout(to);
      if (!res || !res.ok) return;

      const data = await res.json().catch(() => null);
      const place = data?.places?.[0];
      if (!place) return;

      // Merge real, current fields over the model's guesses.
      if (place.displayName?.text) spot.name = place.displayName.text;
      if (place.formattedAddress) spot.address = place.formattedAddress;
      if (place.rating != null) spot.rating = place.rating;
      if (place.userRatingCount != null) spot.rating_count = place.userRatingCount;
      if (place.location) { spot.lat = place.location.latitude; spot.lng = place.location.longitude; }
      // Prefer Google's editorial summary for the "Lola's Pick" description.
      if (place.editorialSummary?.text) spot.description = place.editorialSummary.text;

      // Resolve a real photo URL (skipHttpRedirect → a signed, key-less photoUri).
      const photoName = place.photos?.[0]?.name;
      if (photoName) {
        const pAbort = new AbortController();
        const pTo = setTimeout(() => pAbort.abort(), 5000);
        const pRes = await fetch(
          `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&skipHttpRedirect=true&key=${encodeURIComponent(key)}`,
          { signal: pAbort.signal }
        ).catch(() => null);
        clearTimeout(pTo);
        if (pRes && pRes.ok) {
          const pData = await pRes.json().catch(() => null);
          if (pData?.photoUri) spot.image = pData.photoUri;
        }
      }
    } catch { /* best-effort — keep the model's original spot data */ }
  }));
}

// Pull the first balanced JSON object out of a model reply (handles stray prose
// or ```json fences) and coerce it into the { message, actions } contract.
function parseLolaReply(raw) {
  if (!raw || typeof raw !== 'string') return { message: '', actions: [] };
  let text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      const actions = Array.isArray(obj.actions)
        ? obj.actions.filter(a => a && a.type && a.type !== 'none')
        : [];
      return { message: String(obj.message || '').trim(), actions };
    } catch { /* fall through */ }
  }
  // Not JSON — treat the whole thing as plain copy so the widget still shows it.
  return { message: text, actions: [] };
}

async function handleAiChat(env, request, user) {
  // Reject oversized payloads before parsing JSON (32 KB is ample for 16 turns × 1000 chars).
  const contentLength = parseInt(request.headers.get('content-length') || '0');
  if (contentLength > 32768) return json({ error: 'payload_too_large' }, 413);

  const body = await request.json().catch(() => ({}));

  // Determine which mode the client requested. Concierge mode requires an
  // authenticated user (so we can build their private couple_context); fall back
  // to landing mode otherwise.
  const mode = (body.mode === 'concierge' && user) ? 'concierge' : 'landing';

  // For concierge mode, build the couple_context server-side (cached) rather than
  // trusting the client. Trim to the full "chat" slice — Lola decides per turn
  // which capability fires. Fall back to any client-provided context on failure.
  let lolaContext = null;
  if (mode === 'concierge') {
    try {
      const full = await getCoupleContext(env, request, user);
      lolaContext = trimCoupleContext(full, 'chat');
    } catch {
      lolaContext = body.coupleContext || null;
    }
  }

  // Build the appropriate system prompt
  const systemPrompt = mode === 'concierge'
    ? buildLolaSystemPrompt(lolaContext)
    : buildLandingSystemPrompt();

  // Sanitize and validate incoming conversation history (max 16 turns)
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const userMessages = rawMessages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-16)
    .map(m => ({
      role: m.role,
      // Sanitize user content; pass assistant content through unchanged
      content: m.role === 'user'
        ? sanitizeUserText(String(m.content || ''), 1000)
        : String(m.content || '').slice(0, 4000),
    }))
    .filter(m => m.content.length > 0);

  if (!env.DEEPSEEK_API_KEY) return json({ error: 'ai_not_configured' }, 503);

  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), 10_000); // 10 s hard ceiling
  let dsRes;
  try {
    dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          ...userMessages,
        ],
        // Concierge replies are structured JSON (message + actions) and need more
        // room than a one-line landing answer. Kept tight so the prompt's brevity
        // rules are backstopped rather than relying on the model alone.
        max_tokens: mode === 'concierge' ? 700 : 90,
        temperature: 0.8,
        ...(mode === 'concierge' ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') return json({ error: 'upstream_timeout' }, 504);
    throw e;
  }
  clearTimeout(timeoutId);

  if (!dsRes.ok) {
    const err = await dsRes.text().catch(() => '');
    console.error('DeepSeek error', dsRes.status, err);
    return json({ error: 'upstream_error' }, 502);
  }

  const data = await dsRes.json();

  // Concierge mode returns the strict { message, actions[] } contract. Parse the
  // model's JSON, attach it as `lola`, and overwrite the visible content with the
  // clean message so the existing widget keeps rendering text even if it ignores
  // the actions array.
  if (mode === 'concierge') {
    const rawContent = data?.choices?.[0]?.message?.content || '';
    const lola = parseLolaReply(rawContent);

    // Replace the model's guessed venue data with real, current Google Places
    // info (rating, address, coords, description, photo) before returning.
    const spotsAction = (lola.actions || []).find(a => a.type === 'suggest_date_spots');
    if (spotsAction?.payload?.spots) {
      await enrichSpotsWithPlaces(env, spotsAction.payload.spots);
    }

    data.lola = lola;
    if (data?.choices?.[0]?.message) data.choices[0].message.content = lola.message;
  }

  await phCapture(env, {
    // Landing-page users have no auth; fall back to the CF-provided IP so
    // we can still count unique anon AI users without tying them to PII.
    distinctId: user?.id || `ip_${request.headers.get('cf-connecting-ip') || 'unknown'}`,
    event: 'ai_message_sent',
    properties: {
      surface: mode,
      message_count: userMessages.length,
      tokens_in: data?.usage?.prompt_tokens ?? null,
      tokens_out: data?.usage?.completion_tokens ?? null,
    },
  });

  return json(data);
}

async function getCoupleStats(env, request, user) {
  const tenantId = user.id;

  const [videosRes, settingsRow, musicRes] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as total, MAX(created_at) as last_upload FROM videos WHERE tenant_id = ? AND is_published = 1`
    ).bind(tenantId).first(),
    env.DB.prepare('SELECT anniversary_date, partner_1_name, partner_2_name FROM couple_settings WHERE tenant_id = ?').bind(tenantId).first(),
    env.DB.prepare(
      `SELECT youtube_id, COUNT(*) as plays FROM couple_music_plays WHERE couple_id = ? GROUP BY youtube_id ORDER BY plays DESC LIMIT 5`
    ).bind(tenantId).all().catch(() => ({ results: [] })),
  ]);

  const totalVideos = videosRes?.total ?? 0;
  const lastUploadedAt = videosRes?.last_upload ?? null;
  const anniversaryDate = settingsRow?.anniversary_date ?? null;

  let daysTogether = null;
  if (anniversaryDate) {
    const msPerDay = 86400000;
    daysTogether = Math.floor((Date.now() - new Date(anniversaryDate).getTime()) / msPerDay);
  }

  let daysSinceLastUpload = null;
  if (lastUploadedAt) {
    daysSinceLastUpload = Math.floor((Date.now() - new Date(lastUploadedAt).getTime()) / 86400000);
  }

  return json({
    totalVideos,
    lastUploadedAt,
    daysSinceLastUpload,
    daysTogether,
    partner1Name: settingsRow?.partner_1_name ?? null,
    partner2Name: settingsRow?.partner_2_name ?? null,
    topTrackIds: (musicRes.results || []).map(r => r.youtube_id),
  });
}

async function getCoupleSettings(env, user) {
  const tenantId = user.id;
  const row = await env.DB.prepare(
    'SELECT * FROM couple_settings WHERE tenant_id = ?'
  ).bind(tenantId).first();
  if (!row) {
    return json({
      settings: {
        is_locked: false,
        brand_accent_color: '#e50914',
        notifications_enabled: true,
        privacy_level: 'private',
        anniversary_date: null,
        partner_1_name: null,
        partner_2_name: null,
      }
    });
  }
  return json({
    settings: {
      tenant_id: row.tenant_id,
      anniversary_date: row.anniversary_date || null,
      partner_1_name: row.partner_1_name || null,
      partner_2_name: row.partner_2_name || null,
      is_locked: !!row.is_locked,
      brand_accent_color: row.brand_accent_color || '#e50914',
      notifications_enabled: row.notifications_enabled !== 0,
      privacy_level: row.privacy_level || 'private',
      updated_at: row.updated_at || 0,
    }
  });
}

async function patchCoupleSettings(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const tenantId = user.id;
  const now = Math.floor(Date.now() / 1000);

  const existing = await env.DB.prepare(
    'SELECT is_locked, brand_accent_color, notifications_enabled, privacy_level FROM couple_settings WHERE tenant_id = ?'
  ).bind(tenantId).first();

  const isLocked = existing ? !!existing.is_locked : false;
  const updates = {};

  // Identity fields — always editable (names + anniversary can be changed anytime)
  if (typeof body.partner_1_name === 'string') updates.partner_1_name = sanitizeUserText(body.partner_1_name, 100);
  if (typeof body.partner_2_name === 'string') updates.partner_2_name = sanitizeUserText(body.partner_2_name, 100);
  if (typeof body.anniversary_date === 'string') {
    // Accept YYYY-MM-DD or empty string
    updates.anniversary_date = /^\d{4}-\d{2}-\d{2}$/.test(body.anniversary_date) ? body.anniversary_date : '';
  }

  // Always editable
  if (typeof body.brand_accent_color === 'string' && VALID_ACCENT_COLORS.has(body.brand_accent_color.trim())) {
    updates.brand_accent_color = body.brand_accent_color.trim();
  }
  if (typeof body.notifications_enabled === 'boolean') {
    updates.notifications_enabled = body.notifications_enabled ? 1 : 0;
  }
  const VALID_PRIVACY = ['private', 'friends', 'public'];
  if (typeof body.privacy_level === 'string' && VALID_PRIVACY.includes(body.privacy_level)) {
    updates.privacy_level = body.privacy_level;
  }

  updates.updated_at = now;

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO couple_settings
         (tenant_id, anniversary_date, partner_1_name, partner_2_name,
          is_locked, brand_accent_color, notifications_enabled, privacy_level, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      tenantId,
      updates.anniversary_date || null,
      updates.partner_1_name || null,
      updates.partner_2_name || null,
      updates.is_locked || 0,
      updates.brand_accent_color || '#e50914',
      updates.notifications_enabled !== undefined ? updates.notifications_enabled : 1,
      updates.privacy_level || 'private',
      now
    ).run();
  } else {
    const keys = Object.keys(updates);
    if (keys.length === 1 && keys[0] === 'updated_at') return json({ ok: true, changed: false });
    const setClauses = keys.map(k => `${k} = ?`).join(', ');
    const values = [...keys.map(k => updates[k]), tenantId];
    await env.DB.prepare(`UPDATE couple_settings SET ${setClauses} WHERE tenant_id = ?`)
      .bind(...values).run();
  }

  return json({
    ok: true,
    is_locked: updates.is_locked !== undefined ? !!updates.is_locked : isLocked,
  });
}
