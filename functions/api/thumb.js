// Same-origin image proxy for the Browse (Voroforce) gallery.
//
// The WebGL texture loader fetches each cell's thumbnail with a CORS request.
// Couple thumbnails live on R2 (pub-*.r2.dev) / Supabase Storage, which may not
// send permissive CORS headers, and the /browse/ page runs under COEP
// require-corp. Proxying through this same-origin endpoint sidesteps both: the
// browser sees a same-origin image.
//
// Routed as GET /api/thumb?u=<absolute thumbnail url>. The host is allow-listed
// to avoid turning this into an open proxy.

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

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  const target = url.searchParams.get('u')
  if (!target) return new Response('missing u', { status: 400 })

  let parsed
  try {
    parsed = new URL(target)
  } catch (_) {
    return new Response('bad url', { status: 400 })
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
  headers.set('Cache-Control', 'public, max-age=86400, immutable')
  // Allow embedding under the /browse/ COEP require-corp context.
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return new Response(upstream.body, { status: 200, headers })
}
