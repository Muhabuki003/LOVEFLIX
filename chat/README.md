# LoveFlix Chat Worker — Deployment Guide

Couple-scoped realtime messaging. One room per couple, authenticated via the same
Supabase JWT the main LoveFlix app already issues.

## Architecture

```
chat.html (LoveFlix page)
  └─ CHAT_API (this Worker)
       ├─ Validates Supabase JWT  (GET /auth/v1/user)
       ├─ Fetches couple_id       (Supabase couple_members RLS)
       ├─ D1 persistence          (couple_rooms + couple_messages)
       └─ Durable Object          (realtime WebSocket broadcast per couple)
```

No separate user table or passwords — identity comes entirely from the existing
LoveFlix / Supabase session.

## One-time setup

### 1. Create the D1 database

```bash
cd chat
wrangler d1 create loveflix-chat
```

Copy the `database_id` from the output and paste it into `wrangler.toml`.

### 2. Apply the schema

```bash
wrangler d1 execute loveflix-chat --remote --file=schema.sql
```

### 3. Deploy the Worker

```bash
wrangler deploy
```

The Worker URL will be printed (e.g. `https://loveflix-chat.<your-account>.workers.dev`).

### 4. Update chat.html

Open `/chat.html` in the LoveFlix root and set `CHAT_API`:

```js
const CHAT_API = "https://loveflix-chat.<your-account>.workers.dev";
```

Then deploy/push LoveFlix as usual.

## API reference

All routes require `Authorization: Bearer <loveflix_token>` (or `?token=` for WebSocket).

| Method | Path           | Description                            |
|--------|----------------|----------------------------------------|
| GET    | /api/me        | Current user + partner display info    |
| GET    | /api/history   | Message history (latest 100)           |
| POST   | /api/send      | `{ text }` — persist + broadcast       |
| POST   | /api/typing    | Broadcast ephemeral typing indicator   |
| GET    | /api/connect   | WebSocket upgrade (Durable Object)     |

## Notes

- No `wrangler secret put` needed — auth delegates entirely to Supabase.
- `wrangler.toml` already has the correct `SUPABASE_URL` and `SUPABASE_ANON_KEY`
  for this project; update them if you ever rotate Supabase keys.
- The anon key is safe to commit (it's public-facing by design in Supabase).
