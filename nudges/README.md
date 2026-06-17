# LoveFlix Nudge Sweep Worker

Scheduled Worker that powers Lola's proactive nudges (Lola Knowledge Layer §2).
Every 6 hours it walks each couple, evaluates the trigger table **per account**,
picks the single most-overdue trigger, has Lola (DeepSeek) write one warm line, and
writes one `pending_nudge` row per account. Clients fetch their own nudge on app open
(`assets/loveflix.js` → `fetchPendingNudge`).

## Why this isn't auto-deployed

The main LoveFlix app is a Cloudflare **Pages** project that deploys from GitHub on
merge. This is a separate standalone **Worker** with its own `wrangler.toml`, so the
Pages GitHub integration does **not** deploy it. It needs a one-time manual deploy.

## Prerequisites (already done)

- `supabase_pending_nudge.sql` has been applied to the Supabase project
  (`pending_nudge` table + RLS).
- `database_id` in `wrangler.toml` matches the root `loveflix-db` D1.

## Deploy (one-time, from this directory)

```bash
cd nudges
wrangler deploy

# Same service-role key already used by /api/join-partner on the Pages app.
# Bypasses RLS to read all couples and insert pending_nudge rows.
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Same key the Pages /api/ai endpoint uses. Optional — without it the sweep
# falls back to templated nudge copy instead of model-written lines.
wrangler secret put DEEPSEEK_API_KEY
```

The cron schedule (`0 */6 * * *`), the `DB` binding, and `SUPABASE_URL` are already in
`wrangler.toml`, so `wrangler deploy` registers the trigger automatically.

## Manual test run

Set a `RUN_KEY` secret, then hit the Worker once to force a sweep without waiting
for the cron:

```bash
wrangler secret put RUN_KEY            # any random string
curl "https://loveflix-nudges.<your-subdomain>.workers.dev/run?key=<RUN_KEY>"
# → { "ok": true, "nudges_written": N }
```

Or exercise the scheduled handler locally:

```bash
wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"
```

## Known gaps (documented in worker.js)

- **Chat drought** (`days_since_last_message`) stays `null`: chat lives in the separate
  `loveflix-chat` Worker DB and isn't read here yet, so that trigger never fires from
  this sweep until wired.
- **Date drought** (`days_since_last_date_spot_visit`) stays `null`: there is no
  `date_spots` model in the codebase yet.
