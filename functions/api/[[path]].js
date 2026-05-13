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
  'GET /api/billing/subscription',
  'GET /api/stripe-config',
]);

// LoveFlix plan catalog. Prices in cents (USD). Source of truth for checkout amount.
const LOVEFLIX_PLANS = {
  crush:      { name: 'Crush',      price: 600,  display: '$6',  blurb: '25 videos · 1080p' },
  sweetheart: { name: 'Sweetheart', price: 1200, display: '$12', blurb: 'Unlimited · 4K · custom URL' },
  forever:    { name: 'Forever',    price: 2400, display: '$24', blurb: 'All features · concierge' },
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(),
      ...extra,
    },
  });

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || url.pathname;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

  try {
    const routeKey = `${method} ${path}`;
    const isPublic = PUBLIC_ROUTES.has(routeKey);

    let user = null;
    if (!isPublic) {
      user = await authenticate(request, env);
      if (!user) return json({ error: 'unauthorized' }, 401);
    } else {
      user = await authenticate(request, env).catch(() => null);
    }

    if (method === 'GET' && path === '/api/health') return json({ ok: true });

    if (method === 'GET' && path === '/api/videos') return listVideos(env, url, user);
    if (method === 'POST' && path === '/api/videos') return createVideo(env, request, user);

    const videoIdMatch = path.match(/^\/api\/videos\/([^/]+)$/);
    if (videoIdMatch && method === 'DELETE') return deleteVideo(env, videoIdMatch[1], user);
    if (videoIdMatch && method === 'GET') return getVideo(env, videoIdMatch[1]);

    if (method === 'GET' && path === '/api/upload-url') return getUploadUrl(env, url, user);
    if (method === 'PUT' && path === '/api/upload-object') return uploadObject(env, request, url, user);

    // Editor "Save to LoveFlix" flow.
    if (method === 'POST' && path === '/api/videos/presign') return presignVideoUpload(env, request, url, user);
    if (method === 'POST' && path === '/api/videos/confirm') return confirmVideoUpload(env, request, user);

    if (method === 'GET' && path === '/api/progress') return listProgress(env, user);
    if (method === 'POST' && path === '/api/progress') return saveProgress(env, request, user);

    if (method === 'GET' && path === '/api/settings') return getSettings(env, url, user);
    if (method === 'PUT' && path === '/api/settings') return putSettings(env, request, user);

    if (method === 'POST' && path === '/api/create-payment-intent') return createPaymentIntent(env, request);
    if (method === 'GET'  && path === '/api/billing/subscription') return getMockSubscription();
    if (method === 'GET'  && path === '/api/stripe-config') {
      return json({ publishableKey: env.STRIPE_PUBLISHABLE_KEY || '', testMode: true });
    }

    return json({ error: 'not_found', path }, 404);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('API route failed', { method, path, message, stack: err && err.stack });
    return json({ error: 'server_error', message }, 500);
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
async function listVideos(env, url, user) {
  const tenantId = (user && user.id) || url.searchParams.get('tenant') || env.DEFAULT_TENANT_ID || 'default';
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
  const tenantId = user.id;
  const isPublished = body.is_published === false ? 0 : 1;
  const thumbnailUrl = body.thumbnail_url || '';

  if (thumbnailUrl.startsWith('data:')) {
    return json({
      error: 'thumbnail_not_uploaded',
      message: 'Custom thumbnails must be uploaded to R2 and saved as a public URL, not stored inline as a data URL.',
    }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO videos
       (id, tenant_id, title, description, date, category,
        thumbnail_url, video_url, duration_seconds, is_published, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    tenantId,
    (body.title || 'Untitled').slice(0, 200),
    body.description || '',
    body.date || '',
    body.category || 'Moments',
    thumbnailUrl,
    body.video_url || '',
    parseInt(body.duration_seconds || 0, 10) || 0,
    isPublished,
    parseInt(body.display_order || 0, 10) || 0
  ).run();

  return json({ id, ok: true }, 201);
}

async function deleteVideo(env, id, user) {
  const row = await env.DB.prepare(`SELECT video_url FROM videos WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'not_found' }, 404);

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
async function getSettings(env, url, user) {
  const tenantId = (user && user.id) || url.searchParams.get('tenant') || env.DEFAULT_TENANT_ID || 'default';
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
  const tenantId = user.id;
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

// ---------- Stripe (test mode stub) ----------
// Returns a fake client_secret. Test mode only — wire to real Stripe in follow-up.
async function createPaymentIntent(env, request) {
  const body = await request.json().catch(() => ({}));
  const planId = (body.plan || '').toString().toLowerCase();
  const plan = LOVEFLIX_PLANS[planId];
  if (!plan) return json({ error: 'invalid_plan' }, 400);

  const id = `pi_test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const clientSecret = `${id}_secret_${Math.random().toString(36).slice(2, 16)}`;
  return json({
    clientSecret,
    paymentIntentId: id,
    amount: plan.price,
    currency: 'usd',
    plan: { id: planId, name: plan.name, display: plan.display },
    testMode: true,
  });
}

function getMockSubscription() {
  // Mock data — real Stripe wiring lands in follow-up.
  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  return json({
    plan: { id: 'sweetheart', name: 'Sweetheart', price: 1200, display: '$12', cycle: 'monthly' },
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: Math.floor(next.getTime() / 1000),
    paymentMethod: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2029 },
    testMode: true,
  });
}
