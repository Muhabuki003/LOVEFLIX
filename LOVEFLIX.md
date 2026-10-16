# LOVEFLIX — Source of Truth

> **What it is:** A private, Netflix-style streaming service built for two people — a couple's own
> branded space to upload and watch their videos, listen to music together, chat in real time,
> map their memories, and manage a subscription. One account = one couple.
>
> **Last updated:** 2026-06-05
>
> This document is the canonical reference for what LOVEFLIX is and **which features are live right
> now**. When features change, update this file in the same PR.

---

## 1. Architecture at a glance

LOVEFLIX is a **Cloudflare-first monolith**: static HTML pages served by Cloudflare Pages, a single
catch-all Pages Function for the API, and a few specialized Workers for real-time pieces.

| Layer | Technology |
| --- | --- |
| **Hosting** | Cloudflare Pages (static `.html` + Pages Functions) |
| **API** | Cloudflare Pages Functions — `functions/api/[[path]].js` (single catch-all router) |
| **Primary database** | Cloudflare D1 (SQLite) — `schema.sql` |
| **Auth + couple data** | Supabase (JWT auth, `couple_members`, invites, waitlist, music mirror) |
| **Video / media storage** | Cloudflare R2 bucket `loveflix-videos` (public reads, presigned uploads) |
| **Real-time chat** | Separate Cloudflare Worker + Durable Objects (`chat/`) |
| **Frontend** | Vanilla JS + HTML, **no build step** for the pages |
| **Video editor** | Compiled React SPA served from `/editor/` |
| **Analytics** | PostHog, reverse-proxied through `/ingest/*` (ad-blocker resilient) |
| **Payments** | Stripe (subscriptions + webhooks) |
| **Email** | Resend (partner invites) |
| **Music** | SoundCloud API + YouTube track matching |
| **Video calls** | LiveKit (rooms + tokens) |
| **Maps / directions** | Google Maps JS API (LoveConnect) |
| **Mobile shell** | Capacitor (Android) |

**Auth model (stateless):**
1. User signs in on `loveflix_login_screen.html`; `assets/loveflix.js` calls Supabase
   `${SUPABASE_URL}/auth/v1/token?grant_type=password`.
2. The `access_token` is stored in `localStorage` as `loveflix_token` (refresh token as
   `loveflix_refresh_token`).
3. Every API call sends `Authorization: Bearer <token>`.
4. The Worker validates by hitting `${SUPABASE_URL}/auth/v1/user` — no extra server secret needed.
5. `LoveFlix.requireAuth()` redirects to login if the token is missing; any `401` clears the
   session and redirects.

Couple-scoping is enforced by matching the caller's `user_id` against the `couple_members` table
(Supabase, RLS-protected). Admin-only operations use the `SUPABASE_SERVICE_ROLE_KEY`.

---

## 2. Live features

### 2.1 Authentication & onboarding
- **Email/password login** via Supabase (`loveflix_login_screen.html`).
- **Partner invite flow**: a member sends an invite (`invite.html` → `/api/send-invite`, email via
  Resend); the partner redeems it (`join.html` → `/api/join-partner`, public, rate-limited
  5/hour/IP) which creates their account and links them to the couple via `couple_members`.
- **Onboarding** (`onboarding.html`, `intro.html`, `setup_complete.html`): first-run setup of couple
  names, anniversary, and branding.
- **Who's Watching** profile picker (`whos_watching.html`), Netflix-style.

### 2.2 Video streaming (core)
- **Home feed** (`home.html`): hero banner + category grid, fetched from `/api/videos`.
- **Browse / search** (`browse.html`): browse videos by category.
- **Netflix-style player** (`player.html`): real `<video>` element, custom controls.
  - **Watch progress** saved every ~5s to `/api/progress` and synced across devices
    (`watch_progress` table). Resume where you left off.
  - **Failure-safe playback**: shows a clean "Video coming soon 💕" placeholder (logo on black) when
    there's no `id`, no `video_url`, or the `<video>` fires an error — never broken-player chrome.
- **My List / Favorites** (`my-list.html`, `/api/favorites`): add/remove favorite videos
  (`favorites` table; videos list joins favorites for the current user).

### 2.3 Video upload & management (admin)
- **Admin dashboard** (`admin.html`) with couple stats.
- **Direct-to-R2 upload** (`admin_upload.html`): browser requests a presigned PUT URL
  (`/api/upload-url`) and uploads straight to R2 — no proxying through the Worker.
- **Video management** (`admin_videos.html`): edit metadata, reorder (`display_order`), publish/
  unpublish (`is_published`), delete (removes row **and** R2 object).
- **Admin settings** (`admin_settings.html`): couple name, anniversary, accent color, branding.

### 2.4 Video editor
- A compiled **React SPA** at `/editor/` for creating/editing couple videos, with its own presigned
  upload + confirm flow (`/api/videos/presign`, `/api/videos/confirm`). Includes an AudioContext
  autoplay patch. Ships with a PWA manifest.

### 2.5 Music together
- **Music page** (`music.html`): search SoundCloud, build shared playlists, and play together.
- **SoundCloud proxy**: `/api/soundcloud/search` and stream proxying (server holds the client ID).
- **YouTube matching**: `/api/music/yt-match` finds a YouTube equivalent for a SoundCloud track
  (rate-limited 20/min/IP).
- **Shared playlists**: create/list/delete playlists and add/remove songs
  (`couple_playlists`, `couple_playlist_songs`).
- **Play history**: tracks what the couple listened to (`couple_music_plays`), surfaced as a
  "recently played" widget. Mirrored into Supabase for cross-device access.

### 2.6 Real-time chat
- **Couple chat** (`chat.html`): real-time messaging over **WebSocket via Cloudflare Durable
  Objects** (separate Worker in `chat/`). One room per couple (`couple_rooms`), persisted messages
  (`couple_messages`). See `chat/README.md` for the chat Worker API.

### 2.7 Video calls
- **LiveKit video calling**: token generation via `/api/livekit-token`; client logic in
  `assets/loveflix-call.js`.

### 2.8 Memories: Our Story & LoveConnect
- **Our Story** (`our-story.html`): couple timeline / memories.
- **Our Story Map** (`our-story-map.html`): map of meaningful locations (MapLibre component in
  `components/ui/map.tsx`).
- **LoveConnect** (`loveconnect.html`): Google Maps directions/navigation between partners via the
  `/api/directions` proxy (rate-limited 30/min/IP); Maps key served by `/api/maps-config`.

### 2.9 AI relationship assistant
- **LoveConnect AI** widget (`loveflix-ai-widget.html`, `loveflix-ai-landing-widget.html`) backed by
  `/api/ai`. Dual-mode: works for authenticated couples and for null-user callers on the landing
  widget. Rate-limited (20 req/min/IP, 50 req/day/identity).

### 2.10 Billing & subscriptions
- **Pricing** (`pricing.html`) and **checkout** (`checkout.html`) with **live Stripe** keys.
- Three plans (`LOVEFLIX_PLANS`): **Crush**, **Sweetheart**, **Forever** (monthly + yearly price IDs
  configured in `wrangler.toml`).
- Flows: `/api/create-checkout-session`, `/api/create-subscription-intent`,
  `/api/activate-subscription`, plus a legacy `/api/create-payment-intent`.
- **Webhook** `/api/stripe-webhook` handles subscription/payment lifecycle events.
- **Billing management** (`settings_billing.html`) + `/api/billing/subscription` for status.

### 2.11 Marketing & growth
- **Landing page** (`landing.html`) and **waitlist** (`waitlist.html`) — public email capture into
  the Supabase `waitlist` table (`anon` INSERT only, no SELECT).
- **PostHog analytics** loaded via `assets/posthog.js`, reverse-proxied through `/ingest/*` so it
  survives ad blockers. Config served by `/api/posthog-config`.

### 2.12 Couple settings & stats
- **Couple settings**: names, anniversary, accent color, notifications, privacy, lock state
  (`/api/couple/settings`, `couple_settings` table).
- **Tenant settings blob**: arbitrary couple-wide JSON config with client-side conflict resolution
  (`/api/settings`, `tenant_settings`).
- **Couple stats** (`/api/couple-stats`): video count, last upload, music plays, etc.

---

## 3. Pages reference

### Public (no auth)
| Page | File | Purpose |
| --- | --- | --- |
| Landing | `landing.html` | Marketing homepage |
| Waitlist | `waitlist.html` | Early-access email capture |
| Login | `loveflix_login_screen.html` | Supabase sign-in |
| Pricing | `pricing.html` | Plan comparison |
| Checkout | `checkout.html` | Stripe payment |
| Join invite | `join.html` | Partner invite redemption |
| Intro / onboarding | `intro.html` | First-time intro |
| AI widget (landing) | `loveflix-ai-landing-widget.html` | Embeddable AI assistant |
| AI widget | `loveflix-ai-widget.html` | AI assistant embed |

### Authenticated
| Page | File | Purpose |
| --- | --- | --- |
| Home | `home.html` | Main feed |
| Player | `player.html` | Video player + progress |
| Browse | `browse.html` | Browse / search |
| My List | `my-list.html` | Favorites |
| Music | `music.html` | SoundCloud playlists |
| Chat | `chat.html` | Real-time couple chat |
| Video editor | `editor/` | Create/edit videos (React) |
| Our Story | `our-story.html` | Memory timeline |
| Our Story Map | `our-story-map.html` | Map of locations |
| LoveConnect | `loveconnect.html` | Directions between partners |
| Billing | `settings_billing.html` | Subscription management |
| Who's Watching | `whos_watching.html` | Profile selector |
| Invite | `invite.html` | Send partner invite |
| Onboarding | `onboarding.html` | Post-signup setup |
| Setup complete | `setup_complete.html` | Onboarding success |
| Outro credits | `outro_credits.html` | End credits |
| Admin | `admin.html` | Dashboard |
| Admin upload | `admin_upload.html` | Direct-to-R2 upload |
| Admin videos | `admin_videos.html` | Video management |
| Admin settings | `admin_settings.html` | Couple config |

---

## 4. API reference

All routes are served by `functions/api/[[path]].js`. ✅ = requires a valid Supabase JWT.

### Config & health (public)
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | Liveness check |
| GET | `/api/stripe-config` | Stripe publishable key |
| GET | `/api/posthog-config` | PostHog key + host |
| GET | `/api/maps-config` | Google Maps API key |

### Videos
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/videos` | opt. | List published videos for the couple |
| GET | `/api/videos/:id` | ✅ | Single video |
| POST | `/api/videos` | ✅ | Create video metadata after upload |
| PATCH | `/api/videos/:id` | ✅ | Update metadata |
| DELETE | `/api/videos/:id` | ✅ | Remove row + R2 object |

### Upload
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/upload-url` | ✅ | Presigned PUT URL for R2 |
| POST | `/api/videos/presign` | ✅ | Editor presigned upload |
| POST | `/api/videos/confirm` | ✅ | Editor confirm upload |

### Watch progress & favorites
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/progress` | ✅ | User's watch progress |
| POST | `/api/progress` | ✅ | Save `{ video_id, progress_seconds, completed }` |
| GET | `/api/favorites` | ✅ | List favorites |
| POST | `/api/favorites/:videoId` | ✅ | Add favorite |
| DELETE | `/api/favorites/:videoId` | ✅ | Remove favorite |

### Couple & settings
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/send-invite` | ✅ | Email partner invite (Resend) |
| POST | `/api/join-partner` | — | Redeem invite (rate-limited 5/hr/IP) |
| GET / PATCH | `/api/couple/settings` | ✅ | Couple config |
| GET | `/api/couple-stats` | ✅ | Couple stats |
| GET / PUT | `/api/settings` | ✅ | Tenant-wide JSON settings |

### Music
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET / POST | `/api/music/playlists` | ✅ | List / create playlists |
| GET / DELETE | `/api/music/playlists/:id` | ✅ | Get / delete playlist |
| GET / POST | `/api/music/playlists/:id/songs` | ✅ | List / add songs |
| DELETE | `/api/music/playlists/:id/songs/:songId` | ✅ | Remove song |
| POST | `/api/music/plays` | ✅ | Record a play |
| GET | `/api/music/plays/:coupleId` | ✅ | Play history |
| GET | `/api/music/recent` | ✅ | Recently played widget |
| GET | `/api/music/yt-match` | ✅ | SoundCloud→YouTube match (20/min/IP) |
| GET | `/api/soundcloud/search` | — | Search tracks (60/min/IP) |
| GET | `/api/soundcloud/stream/:trackId` | — | Stream URL proxy |

### Communication & AI
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/livekit-token` | ✅ | LiveKit room token |
| GET | `/api/directions` | ✅ | Google Directions proxy (30/min/IP) |
| POST | `/api/ai` | dual | AI assistant (20/min/IP, 50/day/identity) |

### Stripe / billing
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/create-checkout-session` | Start Stripe Checkout |
| POST | `/api/create-subscription-intent` | SetupIntent to collect card |
| POST | `/api/activate-subscription` | Charge + start subscription |
| POST | `/api/create-payment-intent` | Legacy one-time payment |
| POST | `/api/stripe-webhook` | Webhook (subscription/payment events) |
| GET | `/api/billing/subscription` | Subscription status |

---

## 5. Data model

### Cloudflare D1 — `schema.sql` (primary)
| Table | Purpose |
| --- | --- |
| `tenants` | Couple accounts (subdomain, couple name, accent color) |
| `videos` | Uploaded videos (title, description, date, category, urls, duration, publish state, order) |
| `watch_progress` | Per-user video progress (`progress_seconds`, `completed`, `last_watched_at`) |
| `favorites` | My List entries (`user_id`, `video_id`) |
| `tenant_settings` | Couple-wide JSON config blob |
| `couple_playlists` | Music playlists |
| `couple_playlist_songs` | Songs in playlists (SoundCloud id, title, artist, artwork, stream, YouTube id) |
| `couple_music_plays` | Music play history |
| `couple_settings` | Couple metadata (anniversary, partner names, lock state, accent color, privacy) |

### Supabase (auth + couple management)
| Table | Purpose / RLS |
| --- | --- |
| `waitlist` | Landing signups — `anon` INSERT only, no SELECT |
| `couple_members` | User↔couple membership — members read rows sharing their `couple_id` |
| `couple_invites` | Partner invite tokens — created by service role, marked `used` on redeem |
| `couple_playlists` / `couple_playlist_songs` / `couple_music_plays` | Music mirror — couple members CRUD via RLS |

> **Project rule (`CLAUDE.md`):** every new Supabase table MUST enable RLS with at least one policy in
> the same migration. Use `auth.uid()` + `couple_members` membership for couple-scoped tables, or
> `anon` INSERT + no SELECT for public-facing tables. The D1 schema is separate — RLS does not apply
> there.

### Chat D1 — `chat/schema.sql` (separate Worker)
| Table | Purpose |
| --- | --- |
| `couple_rooms` | One row per couple (`id` = couple UUID) |
| `couple_messages` | Messages (`room_id`, `sender_id`, `sender_name`, `text`, `created_at`) |

---

## 6. Client libraries (`assets/`)
| File | Purpose |
| --- | --- |
| `loveflix.js` | Shared SDK: JWT/session management, token refresh, `requireAuth()`, authed `fetch()`, cross-device settings sync |
| `loveflix-nav.js` | Navigation menu + active-link tracking |
| `loveflix-call.js` | LiveKit video calling |
| `posthog.js` | PostHog analytics client (via `/ingest/*` proxy) |

---

## 7. Configuration (`wrangler.toml`)

**Public vars:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `R2_PUBLIC_URL`, `POSTHOG_PROJECT_API_KEY`,
`STRIPE_PUBLISHABLE_KEY` (live), `STRIPE_PRICE_*` (per-plan, monthly + yearly).

**Secrets** (set via `wrangler pages secret put`):
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`, `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `LIVEKIT_URL`,
`SOUNDCLOUD_CLIENT_ID`, `RESEND_API_KEY`, `GOOGLE_MAPS_API_KEY`.

**Bindings:** D1 (`DB` → `loveflix-db`), R2 (`VIDEOS` → `loveflix-videos`), plus KV (rate limiting).

---

## 8. Subscription plans
| Plan | Highlights |
| --- | --- |
| **Crush** | Entry tier — limited video count, 1080p |
| **Sweetheart** | Unlimited videos, 4K, custom URL |
| **Forever** | Everything + concierge support |

Monthly and yearly Stripe price IDs are wired in `wrangler.toml`; the webhook reconciles subscription
state.

---

## 9. Deploy & local dev (summary)
```bash
# Deploy
wrangler pages deploy . --project-name loveflix

# Local dev
wrangler pages dev . --d1=DB=loveflix-db --r2=VIDEOS=loveflix-videos
# → http://localhost:8788
```
Pages auto-discovers `functions/api/[[path]].js` and routes `/api/*` through it. R2 needs public reads
and CORS (`GET/PUT/HEAD`) for direct browser uploads. See `README.md` for full one-time setup (D1
creation, schema apply, R2 tokens, CORS) and `chat/README.md` for the chat Worker.

---

## 10. Maintaining this document
This file is the **source of truth** for LOVEFLIX's live feature set. When you add, remove, or change
a feature, page, endpoint, or table, update the relevant section here in the **same PR**. If a feature
is partial or experimental, label it as such rather than listing it as fully live.
</content>
</invoke>
