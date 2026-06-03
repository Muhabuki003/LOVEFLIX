// PostHog reverse proxy — routes /ingest/* through this origin so requests
// survive content blockers that filter *.posthog.com. The client SDK is
// configured in assets/posthog.js to call api_host: '/ingest'.
//
// Two upstream hosts:
//   /ingest/static/*  → us-assets.i.posthog.com  (array.js, recorder, web assets)
//   /ingest/*         → us.i.posthog.com         (capture, decide, flags)
//
// Region: US PostHog Cloud. Switch via env.POSTHOG_HOST (host of capture
// endpoint) — the assets host is derived by replacing ".i." with "-assets.i.".

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  // Strip the /ingest prefix.
  const upstreamPath = url.pathname.replace(/^\/ingest/, '') + url.search;

  const captureHost = (env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const assetsHost = captureHost.replace('.i.posthog.com', '-assets.i.posthog.com');

  const upstreamBase = upstreamPath.startsWith('/static/') ? assetsHost : captureHost;
  const upstreamUrl = upstreamBase + upstreamPath;

  // Strip CF / hop-by-hop headers; preserve the client IP so PostHog can
  // resolve $ip / $geoip_* server-side.
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);

  const init = {
    method: request.method,
    headers,
    redirect: 'follow',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  const upstreamRes = await fetch(upstreamUrl, init);

  // Pass the response back untouched. No CORS layer needed — same-origin.
  const respHeaders = new Headers(upstreamRes.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('content-length');
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
}
