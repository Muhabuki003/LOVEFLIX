// Returns public Supabase config for the waitlist page
// Keys never appear in HTML source — only in env vars on Cloudflare
export async function onRequest(context) {
  const { env } = context;
  return new Response(JSON.stringify({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
  }), {
    headers: { 'content-type': 'application/json' },
  });
}
