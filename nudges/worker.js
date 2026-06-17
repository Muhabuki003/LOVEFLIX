// ─────────────────────────────────────────────────────────────────────────────
// LoveFlix — Nudge Sweep Worker (Lola Knowledge Layer §2)
//
// Scheduled Worker. On each cron tick it walks every couple, and for EACH account
// in the couple (nudges are per-account, not per-couple) it:
//   1. builds the recency slice of couple_context from D1 + Supabase,
//   2. evaluates the trigger table and picks the single MOST-OVERDUE trigger,
//   3. has Lola (DeepSeek) write one warm line for that trigger,
//   4. writes one pending_nudge row (service role) — unless the account already
//      has an open, undelivered nudge.
//
// The client fetches its own pending nudge on app open (assets/loveflix.js).
// ─────────────────────────────────────────────────────────────────────────────

// Trigger table — field, threshold, and how to phrase the intent (spec §2).
const TRIGGERS = [
  { key: 'chat_drought',      field: 'days_since_last_message',          gt: 3,  intent: 'prompt them to send their partner a quick note' },
  { key: 'call_drought',      field: 'days_since_last_call',             gt: 7,  intent: 'suggest a voice or video call' },
  { key: 'trip_drought',      field: 'days_since_last_trip',             gt: 90, intent: 'surface the flights menu for a trip to see each other' },
  { key: 'date_drought',      field: 'days_since_last_date_spot_visit',  gt: 21, intent: 'suggest planning a date out' },
  { key: 'music_drought',     field: 'days_since_shared_playlist',       gt: 30, intent: 'offer to start a shared playlist' },
  { key: 'anniversary',       field: 'days_until_anniversary',           lte: 14, intent: 'remind them their anniversary is approaching and suggest a gift or date idea' },
  { key: 'upload_lull',       field: 'days_since_last_video_upload',     gt: 30, intent: 'encourage them to capture a new memory video' },
];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSweep(env));
  },
  // Allow a manual run for testing: `wrangler dev` then hit the Worker URL,
  // or `wrangler dev --test-scheduled` + the /__scheduled route.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run' && url.searchParams.get('key') === env.RUN_KEY && env.RUN_KEY) {
      const n = await runSweep(env);
      return new Response(JSON.stringify({ ok: true, nudges_written: n }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('loveflix-nudges: scheduled worker', { status: 200 });
  },
};

const sbHeaders = env => ({
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'content-type': 'application/json',
});

async function sbGet(env, pathAndQuery) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: sbHeaders(env) });
  if (!res.ok) return [];
  return res.json().catch(() => []);
}

async function runSweep(env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('nudges: SUPABASE_SERVICE_ROLE_KEY not set — cannot run sweep');
    return 0;
  }

  // All couple memberships. Each row is one account in one couple.
  const members = await sbGet(env, 'couple_members?select=couple_id,user_id,is_billing_owner');
  if (!Array.isArray(members) || !members.length) return 0;

  // Group by couple so we can resolve the tenant (billing owner) once per couple.
  const byCouple = new Map();
  for (const m of members) {
    if (!byCouple.has(m.couple_id)) byCouple.set(m.couple_id, []);
    byCouple.get(m.couple_id).push(m);
  }

  let written = 0;
  for (const [coupleId, group] of byCouple) {
    // D1 content tables key on tenant_id = the creator/billing owner's user_id.
    const owner = group.find(g => g.is_billing_owner) || group[0];
    const tenantId = owner.user_id;

    let coupleSignals;
    try {
      coupleSignals = await buildCoupleSignals(env, coupleId, tenantId);
    } catch (e) {
      console.error('nudges: signal build failed', coupleId, e?.message);
      continue;
    }

    for (const member of group) {
      try {
        const made = await maybeNudgeAccount(env, coupleId, member.user_id, coupleSignals);
        if (made) written++;
      } catch (e) {
        console.error('nudges: account sweep failed', member.user_id, e?.message);
      }
    }
  }
  return written;
}

// Recency signals shared by both accounts in a couple. Chat lives in a separate
// Worker DB and isn't read here, so days_since_last_message stays null (that
// trigger simply never fires from this sweep until wired).
async function buildCoupleSignals(env, coupleId, tenantId) {
  const daysSinceSec = v => (v != null ? Math.max(0, Math.floor((Date.now() - Number(v) * 1000) / 86400000)) : null);
  const daysSinceIso = v => (v ? Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 86400000)) : null);

  // ---- D1 (videos, music, settings) ----
  const [settings, lastVideo, lastTrip, lastPlaylist] = await Promise.all([
    env.DB.prepare('SELECT anniversary_date, partner_1_name, partner_2_name FROM couple_settings WHERE tenant_id = ?').bind(tenantId).first().catch(() => null),
    env.DB.prepare('SELECT MAX(created_at) last FROM videos WHERE tenant_id = ? AND is_published = 1').bind(tenantId).first().catch(() => null),
    env.DB.prepare("SELECT MAX(created_at) last FROM videos WHERE tenant_id = ? AND is_published = 1 AND lower(category) IN ('trip','trips','travel')").bind(tenantId).first().catch(() => null),
    env.DB.prepare('SELECT MAX(created_at) last FROM couple_playlists WHERE couple_id = ?').bind(tenantId).first().catch(() => null),
  ]);

  // ---- Supabase (calls) ----
  const calls = await sbGet(env, `call_logs?couple_id=eq.${coupleId}&select=started_at&order=started_at.desc&limit=1`);
  const lastCallIso = Array.isArray(calls) && calls[0] ? calls[0].started_at : null;

  // Anniversary countdown.
  let daysUntilAnniversary = null;
  if (settings?.anniversary_date) {
    const now = new Date();
    const ann = new Date(settings.anniversary_date);
    const next = new Date(now.getFullYear(), ann.getMonth(), ann.getDate());
    if (next < now) next.setFullYear(now.getFullYear() + 1);
    daysUntilAnniversary = Math.ceil((next - now) / 86400000);
  }

  return {
    names: { a: settings?.partner_1_name || null, b: settings?.partner_2_name || null },
    days_since_last_message: null,                       // separate chat DB — not wired
    days_since_last_call: daysSinceIso(lastCallIso),
    days_since_last_trip: daysSinceSec(lastTrip?.last),
    days_since_last_date_spot_visit: null,               // no date_spots model yet
    days_since_shared_playlist: daysSinceSec(lastPlaylist?.last),
    days_until_anniversary: daysUntilAnniversary,
    days_since_last_video_upload: daysSinceSec(lastVideo?.last),
  };
}

// Pick the single most-overdue trigger for one account and write its nudge.
async function maybeNudgeAccount(env, coupleId, userId, signals) {
  // Skip if this account already has an open, undelivered nudge.
  const open = await sbGet(env, `pending_nudge?user_id=eq.${userId}&delivered_at=is.null&dismissed_at=is.null&select=id&limit=1`);
  if (Array.isArray(open) && open.length) return false;

  let best = null; // { trigger, overdue }
  for (const t of TRIGGERS) {
    const v = signals[t.field];
    if (v == null) continue;
    let fired = false, overdue = 0;
    if (t.gt != null && v > t.gt) { fired = true; overdue = v / t.gt; }
    if (t.lte != null && v <= t.lte) { fired = true; overdue = (t.lte - v + 1); } // closer = more overdue
    if (fired && (!best || overdue > best.overdue)) best = { t, value: v, overdue };
  }
  if (!best) return false;

  const message = await writeNudgeCopy(env, best.t, best.value, signals);

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/pending_nudge`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({
      couple_id: coupleId,
      user_id: userId,
      trigger: best.t.key,
      message,
      actions: [],
    }),
  });
  return res.ok;
}

// Have Lola write one warm line for the chosen trigger. Falls back to a templated
// line when DeepSeek isn't configured so the sweep still produces nudges.
async function writeNudgeCopy(env, trigger, value, signals) {
  const fallback = templatedNudge(trigger, value);
  if (!env.DEEPSEEK_API_KEY) return fallback;

  const system = `You are Lola, a warm, playful relationship concierge inside LoveFlix.
Write ONE short nudge (under 3 sentences) for ONE partner. It must be an invitation,
never a guilt-trip. Anchor in the real data point provided. Return ONLY the message text.`;
  const user = `Trigger: ${trigger.key}. Intent: ${trigger.intent}. Data point: ${trigger.field} = ${value}. ` +
    `Partner names if useful: ${signals.names.a || '?'} & ${signals.names.b || '?'}.`;

  try {
    const abort = new AbortController();
    const to = setTimeout(() => abort.abort(), 10000);
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 120, temperature: 0.9,
      }),
    });
    clearTimeout(to);
    if (!r.ok) return fallback;
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || fallback;
  } catch { return fallback; }
}

function templatedNudge(trigger, value) {
  switch (trigger.key) {
    case 'chat_drought':   return `It's been ${value} days since your last message — send them a little hello? ♥`;
    case 'call_drought':   return `${value} days since your last call. A quick voice note might make their day.`;
    case 'trip_drought':   return `It's been a while since you saw each other in person — want to look at flights?`;
    case 'date_drought':   return `Been ${value} days since a date out. Shall I find you a spot?`;
    case 'music_drought':  return `Your shared playlist has been quiet for ${value} days — want to add a few songs together?`;
    case 'anniversary':    return `Your anniversary is just ${value} day${value === 1 ? '' : 's'} away — want help planning something special?`;
    case 'upload_lull':    return `${value} days since your last memory video. Got a moment worth keeping?`;
    default:               return `I've got an idea for you two — open me up?`;
  }
}
