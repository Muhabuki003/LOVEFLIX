# LoveFlix — Hermes Project Memory

## What is LoveFlix
A private Netflix-style streaming platform built exclusively for couples.
Think Netflix meets BeReal meets Google Maps — for two people only.
Live at: https://loveflix-eac.pages.dev

## Owner
- GitHub: Muhabuki003
- Repo: https://github.com/Muhabuki003/LOVEFLIX
- Developer: Adrien Muhabuki (goes by "Am")

---

## Stack

### Frontend
- **Vanilla JS + HTML only** — no React, no bundler, no framework
- Multi-page app — each feature is its own `.html` file
- Tailwind via CDN only
- MapLibre GL JS for LoveConnect map feature
- PostHog for session replay and analytics
- Sentry for error tracking

### Backend / Infrastructure
- **Cloudflare Pages** — static hosting + Pages Functions as API
- **Cloudflare D1** — primary relational database (SQLite-compatible)
  - database_name: `loveflix-db`
  - database_id: `daba2b39-0ff8-4ef0-b28a-e586bb1fd6a6`
- **Cloudflare R2** — video and image storage
  - bucket: `loveflix-videos`
  - public URL: `https://pub-41c1138b6caa46559a3d65cc2f95e4fb.r2.dev`
- **Cloudflare KV** — rate limiting
  - binding: `RATE_LIMIT_KV`
- **Supabase** — authentication ONLY (not the database)
  - URL: `https://jeblgjjutyzzdursjqnn.supabase.co`
  - Every Supabase table MUST have RLS enabled
  - Use `auth.uid()` and `couple_members` for couple-scoped policies
- **LiveKit** — video calling (LoveConnect feature)
- **Stripe** — subscription billing

### Mobile
- Capacitor for Android app wrapper (`/android` folder)

---

## Project Structure

```
loveflix/
├── functions/          # Cloudflare Pages Functions (API routes)
│   ├── api/            # REST API endpoints
│   └── ingest/         # Video/content ingestion workers
├── components/         # Shared HTML components
├── lib/                # Shared JS utilities
├── assets/             # Static assets
├── chat/               # Chat feature files
├── editor/             # Video editor feature
├── flights/            # Flights feature
├── android/            # Capacitor Android app
├── www/                # Capacitor build output
├── schema.sql          # D1 (Cloudflare) database schema
├── supabase_rls_policies.sql  # Supabase RLS policies
├── wrangler.toml       # Cloudflare config (DO NOT expose secrets)
├── CLAUDE.md           # Project rules
└── [feature].html      # One HTML file per feature/page
```

---

## Key Pages / Features

| File | Feature |
|------|---------|
| `landing.html` | Marketing landing page |
| `home.html` | Main home feed |
| `browse.html` | Browse content |
| `player.html` | Video player |
| `chat.html` | Couple chat |
| `loveconnect.html` | Location sharing map (MapLibre + Google Maps) |
| `music.html` | Music feature (SoundCloud integration) |
| `our-story.html` | Couple story/timeline |
| `our-story-map.html` | Story map view |
| `my-list.html` | Watchlist |
| `pricing.html` | Subscription pricing |
| `checkout.html` | Stripe checkout |
| `settings_billing.html` | Billing management |
| `admin.html` | Admin dashboard |
| `admin_upload.html` | Video upload admin |
| `admin_videos.html` | Video management |
| `onboarding.html` | User onboarding |
| `invite.html` | Partner invite flow |
| `join.html` | Join couple flow |
| `whos_watching.html` | Profile selector (Netflix-style) |
| `outro_credits.html` | Credits screen |
| `waitlist.html` | Waitlist signup |

---

## Stripe Subscription Plans

| Plan | Monthly Price ID | Yearly Price ID |
|------|-----------------|-----------------|
| Crush | `price_1TY6rfA20Y7L8XqMohsuGEF7` | `price_1TY6rfA20Y7L8XqMkvQtmukF` |
| Sweetheart | `price_1TY6rfA20Y7L8XqMZhPdtYDo` | `price_1TY6rgA20Y7L8XqM2JvGksJB` |
| Forever | `price_1TY6rgA20Y7L8XqMq4qFpwYl` | `price_1TY6rhA20Y7L8XqMeJ8advP5` |

---

## Environment Variables

### Public (in wrangler.toml — safe to commit)
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `R2_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_URL`
- `POSTHOG_PROJECT_API_KEY`
- `POSTHOG_HOST`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_PRICE_*` (all price IDs)

### Secrets (set via `wrangler pages secret put` — NEVER commit)
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_URL`
- `SOUNDCLOUD_CLIENT_ID`

---

## Critical Rules (from CLAUDE.md)

1. **Every new Supabase table MUST have RLS enabled.** No migration without matching `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and at least one policy.
2. Follow existing policy pattern: use `auth.uid()` and check membership via `couple_members` for couple-scoped tables.
3. `anon` INSERT + no SELECT for public-facing tables (e.g. `waitlist`).
4. D1 (Cloudflare) schema (`schema.sql`) is separate — RLS does NOT apply there.
5. **Never expose secrets** — only `wrangler pages secret put` for sensitive keys.
6. This is vanilla JS only — do NOT introduce React, Vue, or any framework.
7. No bundler — CDN imports only.

---

## Git Workflow

- Repo: `git@github.com:Muhabuki003/LOVEFLIX.git`
- Default branch: `main`
- **Always create a feature branch** before making changes:
  ```bash
  git checkout -b feature/description-of-change
  ```
- **Never push directly to main**
- PR naming convention: `feat:`, `fix:`, `chore:`, `refactor:`
- After changes: commit → push branch → open PR via `gh pr create`

### Standard PR flow:
```bash
git checkout -b feat/your-feature
# make changes
git add .
git commit -m "feat: description"
git push origin feat/your-feature
gh pr create --title "feat: description" --body "What this PR does"
```

---

## Deployment

- Auto-deploys to Cloudflare Pages on push to `main`
- Preview deployments on every PR branch automatically
- Live URL: https://loveflix-eac.pages.dev
- Deploy command: none needed — Cloudflare Pages handles it
- Build output dir: `.` (root — static files served directly)

---

## Analytics & Monitoring

- **PostHog** — session replay, events, funnels
  - Host: `https://us.i.posthog.com`
  - Config served via `/api/posthog-config`
- **Sentry** — error tracking

---

## Key Architectural Decisions

1. **Supabase = auth only.** All app data lives in Cloudflare D1, not Supabase.
2. **R2 for all media** — videos and images served from R2 public URL.
3. **Pages Functions = serverless API** — no separate Worker needed for most endpoints.
4. **Couple-based data model** — everything scoped to a couple, not individual users. Core table: `couple_members`.
5. **YouTube sync via Cloudflare Durable Objects** — for shared watchlist sync.
6. **MapLibre GL JS + Google Maps** for LoveConnect location tracking.
7. **LiveKit** for video calling between partners.

---

## When Working on LoveFlix

- Always check `schema.sql` before adding new D1 tables
- Always check `supabase_rls_policies.sql` before adding Supabase tables
- Test API routes via `wrangler pages dev` locally
- Use `wrangler d1 execute loveflix-db --file=migration.sql` for DB migrations
- Check `wrangler.toml` for all bindings before adding new API routes
- PostHog silently no-ops when key is unset — safe for local dev
