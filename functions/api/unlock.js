// Server-side gate password check
// Env var: WAITLIST_BYPASS (set via `wrangler pages secret put WAITLIST_BYPASS`)
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code || code !== env.WAITLIST_BYPASS) {
    return new Response(JSON.stringify({ ok: false }), {
      headers: { 'content-type': 'application/json' },
      status: 401,
    });
  }

  // Set HttpOnly cookie — expires in 24h
  const cookie = `lf_unlock=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'content-type': 'application/json',
      'set-cookie': cookie,
    },
  });
}
