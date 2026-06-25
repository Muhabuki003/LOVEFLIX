// Index-based thumbnail proxy for the Browse (Voroforce) gallery.
// GET /api/browse/img/{n}?tid={tenantId}
//
// Mirrors the pattern from `public/media/single/{n}.jpg` in the upstream
// nothing-to-watch repo: a predictable index-keyed URL that the engine's
// layerSrcFormat can reference directly, with no encoded thumbnail URL in the
// query string.
//
// Tenant ID is not a secret in this context — it is the couple creator's
// Supabase auth user UUID, already sent in /api/videos calls. The videos it
// exposes are limited to is_published = 1 rows, same as the public /api/videos
// endpoint. Cloudflare caches responses at the edge for 24h.

const ALLOWED_HOST_SUFFIXES = ['.r2.dev', '.r2.cloudflarestorage.com', '.supabase.co']

function hostAllowed(hostname, env) {
  if (ALLOWED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) return true
  try {
    if (env.R2_PUBLIC_URL) {
      const h = new URL(env.R2_PUBLIC_URL).hostname
      if (h && hostname === h) return true
    }
  } catch (_) {}
  return false
}

export async function onRequestGet({ request, env, params }) {
  const index = parseInt(params.index, 10)
  if (Number.isNaN(index) || index < 0) {
    return new Response('bad index', { status: 400 })
  }

  const url = new URL(request.url)
  const tenantId = url.searchParams.get('tid') || env.DEFAULT_TENANT_ID
  if (!tenantId) {
    return new Response('missing tid', { status: 400 })
  }

  let thumbnailUrl
  try {
    const { results } = await env.DB.prepare(
      `SELECT thumbnail_url FROM videos
       WHERE tenant_id = ? AND is_published = 1 AND thumbnail_url != ''
       ORDER BY display_order ASC, created_at DESC`
    )
      .bind(tenantId)
      .all()
    const rows = (results || []).filter((r) => r.thumbnail_url)
    if (!rows.length) return new Response('no videos', { status: 404 })
    thumbnailUrl = rows[((index % rows.length) + rows.length) % rows.length].thumbnail_url
  } catch (_) {
    return new Response('db error', { status: 500 })
  }

  // Apply Supabase image transform for smaller tile size.
  let src = thumbnailUrl
  if (src.includes('/storage/v1/object/public/')) {
    const sep = src.includes('?') ? '&' : '?'
    src = `${src.replace('/object/public/', '/render/image/public/')}${sep}width=512&quality=70`
  }

  let parsed
  try {
    parsed = new URL(src)
  } catch (_) {
    return new Response('bad thumbnail url', { status: 502 })
  }
  if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname, env)) {
    return new Response('forbidden host', { status: 403 })
  }

  let upstream
  try {
    upstream = await fetch(parsed.toString(), {
      headers: { Accept: 'image/*' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    })
  } catch (_) {
    return new Response('upstream error', { status: 502 })
  }
  if (!upstream.ok) {
    return new Response('upstream ' + upstream.status, { status: 502 })
  }

  const contentType = upstream.headers.get('content-type') || ''
  if (!contentType.startsWith('image/')) {
    return new Response('not an image', { status: 415 })
  }

  const headers = new Headers()
  headers.set('Content-Type', contentType)
  // Browser caches for 1h; Cloudflare edge caches for 24h.
  headers.set('Cache-Control', 'public, max-age=3600, s-maxage=86400')
  // Allow the WebGL loader to fetch this under the /browse/ COEP context.
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(upstream.body, { status: 200, headers })
}
