// LoveFlix API — Cloudflare Pages Function (catch-all under /api/*)
// Routes handled here:
//   GET    /api/health
//   GET    /api/me
//   GET    /api/tenant
//   PUT    /api/tenant
//   GET    /api/videos
//   POST   /api/videos
//   GET    /api/videos/:id
//   PUT    /api/videos/:id
//   DELETE /api/videos/:id
//   GET    /api/upload-url?filename=...&type=...
//   GET    /api/progress
//   POST   /api/progress
//   GET    /api/favorites
//   POST   /api/favorites           { video_id }
//   DELETE /api/favorites/:videoId

const PUBLIC_ROUTES = new Set(['GET /api/health', 'GET /api/videos']);

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
    if (method === 'GET' && path === '/api/me') return getMe(env, user);

    if (method === 'GET' && path === '/api/tenant') return getTenant(env, user);
    if (method === 'PUT' && path === '/api/tenant') return upsertTenant(env, request, user);

    if (method === 'GET' && path === '/api/videos') return listVideos(env, url);
    if (method === 'POST' && path === '/api/videos') return createVideo(env, request, user);

    const videoIdMatch = path.match(/^\/api\/videos\/([^/]+)$/);
    if (videoIdMatch && method === 'DELETE') return deleteVideo(env, videoIdMatch[1], user);
    if (videoIdMatch && method === 'PUT') return updateVideo(env, videoIdMatch[1], request, user);
    if (videoIdMatch && method === 'GET') return getVideo(env, videoIdMatch[1]);

    if (method === 'GET' && path === '/api/upload-url') return getUploadUrl(env, url, user);

    if (method === 'GET' && path === '/api/progress') return listProgress(env, user);
    if (method === 'POST' && path === '/api/progress') return saveProgress(env, request, user);

    if (method === 'GET' && path === '/api/favorites') return listFavorites(env, user);
    if (method === 'POST' && path === '/api/favorites') return addFavorite(env, request, user);
    const favMatch = path.match(/^\/api\/favorites\/([^/]+)$/);
    if (favMatch && method === 'DELETE') return removeFavorite(env, favMatch[1], user);

    return json({ error: 'not_found', path }, 404);
  } catch (err) {
    return json({ error: 'server_error', message: err.message }, 500);
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

// ---------- Me / Tenant ----------
async function getMe(env, user) {
  const tenant = await tenantForUser(env, user.id);
  return json({ user: { id: user.id, email: user.email }, tenant });
}

async function tenantForUser(env, userId) {
  const row = await env.DB.prepare(
    `SELECT id, subdomain, couple_name, accent_color, creator_id, partner_email, created_at
       FROM tenants WHERE creator_id = ? LIMIT 1`
  ).bind(userId).first();
  return row || null;
}

async function getTenant(env, user) {
  const tenant = await tenantForUser(env, user.id);
  return json({ tenant });
}

async function upsertTenant(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const existing = await tenantForUser(env, user.id);
  const id = existing ? existing.id : `t_${user.id.slice(0, 8)}_${Date.now().toString(36)}`;
  const subdomain = (body.subdomain || existing?.subdomain || id).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  const coupleName = (body.couple_name ?? existing?.couple_name ?? '').slice(0, 120);
  const accentColor = body.accent_color || existing?.accent_color || '#e50914';
  const partnerEmail = body.partner_email ?? existing?.partner_email ?? '';

  if (existing) {
    await env.DB.prepare(
      `UPDATE tenants SET subdomain=?, couple_name=?, accent_color=?, partner_email=? WHERE id=?`
    ).bind(subdomain, coupleName, accentColor, partnerEmail, id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO tenants (id, subdomain, couple_name, accent_color, creator_id, partner_email)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, subdomain, coupleName, accentColor, user.id, partnerEmail).run();
  }
  const tenant = await env.DB.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(id).first();
  return json({ tenant });
}

// ---------- Videos ----------
async function listVideos(env, url) {
  const tenantId = url.searchParams.get('tenant') || env.DEFAULT_TENANT_ID || 'default';
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
  const tenantId = body.tenant_id || env.DEFAULT_TENANT_ID || 'default';
  const isPublished = body.is_published === false ? 0 : 1;

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
    body.thumbnail_url || '',
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

async function updateVideo(env, id, request, user) {
  const body = await request.json().catch(() => ({}));
  const existing = await env.DB.prepare(`SELECT * FROM videos WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: 'not_found' }, 404);

  const merged = {
    title: body.title ?? existing.title,
    description: body.description ?? existing.description,
    date: body.date ?? existing.date,
    category: body.category ?? existing.category,
    thumbnail_url: body.thumbnail_url ?? existing.thumbnail_url,
    video_url: body.video_url ?? existing.video_url,
    duration_seconds: body.duration_seconds ?? existing.duration_seconds,
    is_published: body.is_published === undefined ? existing.is_published : (body.is_published ? 1 : 0),
    display_order: body.display_order ?? existing.display_order,
  };

  await env.DB.prepare(
    `UPDATE videos SET
       title=?, description=?, date=?, category=?,
       thumbnail_url=?, video_url=?, duration_seconds=?, is_published=?, display_order=?
     WHERE id=?`
  ).bind(
    merged.title, merged.description, merged.date, merged.category,
    merged.thumbnail_url, merged.video_url, merged.duration_seconds,
    merged.is_published, merged.display_order, id
  ).run();

  return json({ ok: true });
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

// ---------- Favorites ----------
async function listFavorites(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT video_id, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(user.id).all();
  return json({ favorites: results || [] });
}

async function addFavorite(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const videoId = body.video_id;
  if (!videoId) return json({ error: 'video_id required' }, 400);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO favorites (user_id, video_id) VALUES (?, ?)`
  ).bind(user.id, videoId).run();
  return json({ ok: true });
}

async function removeFavorite(env, videoId, user) {
  await env.DB.prepare(
    `DELETE FROM favorites WHERE user_id = ? AND video_id = ?`
  ).bind(user.id, videoId).run();
  return json({ ok: true });
}

// ---------- Presigned R2 upload URL (S3-compatible, AWS SigV4) ----------
async function getUploadUrl(env, url, user) {
  const filename = (url.searchParams.get('filename') || `upload-${Date.now()}.bin`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const contentType = url.searchParams.get('type') || 'application/octet-stream';
  const folder = url.searchParams.get('folder') || 'videos';
  const key = `${folder}/${user.id}/${Date.now()}-${filename}`;

  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET_NAME;

  if (!accessKey || !secretKey) {
    return json({
      error: 'r2_not_configured',
      message: 'Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY via `wrangler pages secret put`.',
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

  const publicUrl = env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
    : `https://${host}/${bucket}/${key}`;

  return json({
    upload_url: presigned,
    key,
    public_url: publicUrl,
    content_type: contentType,
    expires_in: 3600,
  });
}

// AWS SigV4 query-string presign for `PUT s3://bucket/key`.
async function presignS3PutUrl({ accessKey, secretKey, region, service, host, bucket, key, expiresIn, contentType }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKey}/${credentialScope}`;
  const signedHeaders = 'host';

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

  const canonicalHeaders = `host:${host}\n`;
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
