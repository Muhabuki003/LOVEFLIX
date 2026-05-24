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
  'POST /api/stripe-webhook',
  'POST /api/join-partner',
  // Google Maps JS API key for the LoveConnect navigation map. The page fetches
  // this on load (no auth header) before any token-gated work, and the key is a
  // referrer-restricted public client key that ships in the Maps script URL
  // anyway — so it is intentionally public here. Lock it down with an HTTP
  // referrer restriction in the Google Cloud console.
  'GET /api/maps-config',
  // SoundCloud proxy — search is public so the music page can search before
  // the auth token is fully checked. Stream uses a dynamic path matched below.
  'GET /api/soundcloud/search',
]);

// LoveFlix plan catalog. Prices in cents (USD). Source of truth for checkout amount.
const LOVEFLIX_PLANS = {
  crush:      { name: 'Crush',      price: 600,  display: '$6',  blurb: '25 videos · 1080p' },
  sweetheart: { name: 'Sweetheart', price: 1200, display: '$12', blurb: 'Unlimited · 4K · custom URL' },
  forever:    { name: 'Forever',    price: 2400, display: '$24', blurb: 'All features · concierge' },
};

// json() picks up the per-request origin stored at the top of onRequest.
let _reqOrigin = '';
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
  const origin = ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : [...ALLOWED_ORIGINS][0];
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-tenant-id',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
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
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || url.pathname;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(_reqOrigin) });

  try {
    const routeKey = `${method} ${path}`;
    // SoundCloud stream has a dynamic segment so it can't be in PUBLIC_ROUTES set.
    const isSoundCloudRoute = method === 'GET' && path.startsWith('/api/soundcloud/');
    const isPublic = PUBLIC_ROUTES.has(routeKey) || isSoundCloudRoute;

    let user = null;
    if (!isPublic) {
      user = await authenticate(request, env);
      if (!user) return json({ error: 'unauthorized' }, 401);
    } else {
      user = await authenticate(request, env).catch(() => null);
    }

    if (method === 'GET' && path === '/api/health') return json({ ok: true });

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

    if (method === 'POST' && path === '/api/create-checkout-session') return createCheckoutSession(env, request, url);
    if (method === 'POST' && path === '/api/create-subscription-intent') return createSubscriptionIntent(env, request);
    if (method === 'POST' && path === '/api/activate-subscription') return activateSubscription(env, request);
    if (method === 'POST' && path === '/api/create-payment-intent') return createPaymentIntent(env, request);
    if (method === 'POST' && path === '/api/stripe-webhook') return handleStripeWebhook(env, request);
    if (method === 'GET'  && path === '/api/billing/subscription') return getBillingSubscription(env, request);
    if (method === 'GET'  && path === '/api/stripe-config') {
      return json({ publishableKey: env.STRIPE_PUBLISHABLE_KEY || '' });
    }

    if (method === 'POST' && path === '/api/livekit-token') return livekitToken(env, request, user);

    // Hands the Google Maps JS API key to the LoveConnect page so it can inject
    // the Maps script without the key ever being hardcoded in static HTML.
    if (method === 'GET' && path === '/api/maps-config') {
      return json({ key: env.GOOGLE_MAPS_API_KEY || '' });
    }

    if (method === 'GET' && path === '/api/directions') return getDirections(env, url, user);

    if (method === 'GET' && path === '/api/soundcloud/search') return soundcloudSearch(env, url);
    const scStreamMatch = path.match(/^\/api\/soundcloud\/stream\/([^/]+)$/);
    if (scStreamMatch && method === 'GET') return soundcloudStream(env, scStreamMatch[1]);

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
  const stmt = env.DB.prepare(
    `SELECT id, tenant_id, title, description, date, category,
            thumbnail_url, video_url, duration_seconds, is_published,
            display_order, created_at
       FROM videos
      WHERE tenant_id = ? AND is_published = 1
      ORDER BY display_order ASC, created_at DESC`
  ).bind(tenantId);
  const { results } = await stmt.all();
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
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      if (env.DB && sub.customer) {
        await env.DB.prepare(
          `UPDATE subscriptions SET status = 'canceled' WHERE customer_id = ?`
        ).bind(sub.customer).run().catch(() => null);
      }
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
  const wsUrl = env.LIVEKIT_WS_URL;

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

// ── SoundCloud proxy ──────────────────────────────────────────────────────────
// Set SOUNDCLOUD_CLIENT_ID via: wrangler pages secret put SOUNDCLOUD_CLIENT_ID
// Obtain a client_id by registering at https://soundcloud.com/you/apps or by
// inspecting the network tab on soundcloud.com (look for client_id= query param).

async function soundcloudSearch(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ tracks: [] });

  const clientId = env.SOUNDCLOUD_CLIENT_ID;
  if (!clientId) return json({ error: 'soundcloud_not_configured', tracks: [] }, 503);

  try {
    const scRes = await fetch(
      `https://api.soundcloud.com/tracks?q=${encodeURIComponent(q)}&limit=20&client_id=${encodeURIComponent(clientId)}&linked_partitioning=1`,
      { headers: { Accept: 'application/json' } }
    );
    if (!scRes.ok) return json({ tracks: [] });

    const data = await scRes.json();
    // v1 returns an array; paginated responses wrap in { collection: [...] }.
    const raw = Array.isArray(data) ? data : (data.collection || []);

    const tracks = raw
      .filter(t => t.streamable)
      .map(t => ({
        id:      t.id,
        title:   t.title   || 'Unknown',
        artist:  t.user?.username || 'Unknown',
        artwork: t.artwork_url
          ? t.artwork_url.replace('-large', '-t300x300')
          : '',
      }));

    return json({ tracks });
  } catch (_) {
    return json({ tracks: [] });
  }
}

async function soundcloudStream(env, rawId) {
  const id = parseInt(rawId, 10);
  if (!id || !isFinite(id)) return json({ error: 'invalid_id' }, 400);

  const clientId = env.SOUNDCLOUD_CLIENT_ID;
  if (!clientId) return json({ error: 'soundcloud_not_configured' }, 503);

  try {
    // SoundCloud returns a 302 redirect to the actual CDN audio URL.
    // Using redirect:'manual' avoids streaming the audio body through the worker.
    const scRes = await fetch(
      `https://api.soundcloud.com/tracks/${id}/stream?client_id=${encodeURIComponent(clientId)}`,
      { redirect: 'manual' }
    );

    const streamUrl = scRes.headers.get('location');
    if (!streamUrl) return json({ error: 'not_streamable' }, 404);

    return json({ streamUrl });
  } catch (_) {
    return json({ error: 'fetch_failed' }, 502);
  }
}
