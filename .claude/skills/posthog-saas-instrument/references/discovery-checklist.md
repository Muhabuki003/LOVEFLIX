# Discovery Checklist (Phase 1)

Fill this in by inspecting the repo with `Glob`, `Grep`, and `Read`. Do not edit code in this phase. The completed checklist becomes the basis of the Discovery Report shown to the user before Phase 2.

---

## 1. Stack

- **Framework + version**: _(e.g. Next.js 15.3.0, App Router)_
- **Detection sources**: `package.json` / `requirements.txt` / `Gemfile` / `composer.json` / `go.mod` / `pyproject.toml`
- **Package manager**: _(pnpm | yarn | npm | bun)_ — from lockfile: `pnpm-lock.yaml` > `yarn.lock` > `package-lock.json` > `bun.lockb`. **Never mix managers.**
- **TypeScript?**: yes/no — check `tsconfig.json`
- **Existing analytics / error / observability tooling**: _(Sentry, Datadog, GA4, Segment, Mixpanel, LogRocket, FullStory, Plausible, Rudderstack — any of these affect where PostHog slots in)_
  - Grep: `@sentry/`, `datadog-rum`, `gtag(`, `segment.com`, `mixpanel`, `logrocket`, `fullstory`, `rudderanalytics`

### Notes

- If Sentry is present: PostHog's `capture_exceptions` can either supplement or replace it; ask the user.
- If Segment is present: PostHog can be a Segment destination instead of a parallel install; ask before installing the SDK directly.

---

## 2. Auth surface

Find every place a user becomes known to the system. Grep patterns:

```
signIn|signUp|signin|signup|login|register|auth\/callback|oauth|magic-link
supabase\.auth|next-auth|clerk|auth0|firebase\.auth|lucia|better-auth|nextauth
```

Identify for each:

- **Signup completion site** — where the user record is created and the response returns successful registration. (Client form handler OR server route handler, depending on flow.)
- **Signin completion site** — same, for returning users.
- **OAuth / SSO callback** — almost always a server route (`app/api/auth/callback/route.ts`, `pages/api/auth/[...nextauth].ts`, Rails `callbacks_controller.rb`).
- **Email confirmation required?** — if yes, `user_signed_up` should include a `confirmed: false` property and a separate `user_email_confirmed` event captures the confirmation moment.
- **Auth provider** — Supabase / NextAuth / Clerk / Auth0 / Firebase / Lucia / Better Auth / custom. Each has a different integration point for `posthog.identify`.

### Notes

- If using NextAuth or Better Auth, identify in the `signIn` event handler/callback, not in `useSession` (which fires too often).
- If using Clerk, use Clerk's `useUser` hook to drive identify, and call it once on mount inside a top-level `ClerkProvider` wrapper.
- If using Supabase, use the `onAuthStateChange` listener to identify on `SIGNED_IN`.

---

## 3. Billing / monetization surface

Find every place money or subscription state changes. Grep patterns:

```
stripe|paddle|lemonsqueezy|chargebee|polar|orb
webhook|checkout\.session\.completed|customer\.subscription
invoice\.payment_failed|payment_intent\.succeeded
```

Identify for each:

- **Webhook handler** — server-only route. Usually `app/api/webhooks/stripe/route.ts`, `pages/api/webhooks/stripe.ts`, or Rails `webhooks_controller.rb`. This is where `subscription_activated`, `subscription_canceled`, `subscription_payment_failed` get captured.
- **Checkout entry points** — where the user is sent to Stripe Checkout / Paddle / etc. This is where `checkout_started` fires (client-side, in the click handler).
- **Subscription-state writes** — the database operation that updates the user/org's subscription tier. Used to sanity-check that webhook captures fire when DB writes happen.

### Notes

- Webhooks have no user session. The webhook payload contains the customer id; map customer id → user id via your database, then use the user id as `distinctId`.
- If no billing is detected, skip all `subscription_*` events; record this in the Discovery Report as a deliberate omission.

---

## 4. Core product surface

This is the judgment call of the audit. The goal is to identify the 3–7 actions that represent the product's actual value, the things a user would tell a friend they did with the product.

Methods:

- List all API routes / server actions / controllers
- List all forms — grep `<form`, `onSubmit`, `useFormState`, `useMutation`, server action exports (`async function ...`)
- Read the marketing site / landing page / README to see what the product claims to do

Pick 3–7 that match the verbs the product is built around:

- `note_created`, `note_shared`, `note_exported` for a note app
- `transcript_generated`, `transcript_translated` for a transcription app
- `image_generated`, `image_upscaled` for an image app
- `report_created`, `report_exported` for a reporting app
- `team_invited`, `team_member_added` for a multiplayer app

Each becomes an `<action>_started` / `<action>_completed` / `<action>_failed` triplet in the taxonomy.

**If the product surface is ambiguous**, ask the user to rank: "Looking at your routes, the top candidates for 'core actions' are [A, B, C, D, E, F]. Which 3–5 should we instrument first?"

---

## 5. Env-var conventions

Look at how the project already loads env vars. Match the pattern; do not introduce a new one.

| Project signal | Convention |
|---|---|
| Next.js + `process.env.NEXT_PUBLIC_*` direct reads | use raw env, add to `.env.local.example` |
| Next.js + `src/lib/env.ts` or `src/env.mjs` with Zod | add to the schema |
| Vite + `import.meta.env.VITE_*` | use `VITE_POSTHOG_TOKEN` |
| Nuxt + `runtimeConfig` | add to `runtimeConfig.public` |
| SvelteKit + `$env/static/public` | use `PUBLIC_POSTHOG_TOKEN` |
| Remix + `process.env` + loader exposure | expose via root loader |
| Rails + `Rails.application.credentials` | add to encrypted credentials |
| Rails + ENV directly | add to `.env` and document |
| Django + `os.environ` or `django-environ` | match |

### Notes

- Public token goes in the client-exposed env var per the framework's convention.
- A separate `POSTHOG_PERSONAL_API_KEY` is needed only if the integration uses feature flags from the server with `getAllFlags`. This is server-only; never `NEXT_PUBLIC_*` it.

---

## 6. CSP / security headers

Read the existing CSP. PostHog needs additions to two directives.

Sources to check:

- `next.config.{js,mjs,ts}` — `headers()` returning `Content-Security-Policy`
- `vercel.json` — `headers` array
- `helmet` config in Express
- Rails `content_security_policy` initializer
- `<meta http-equiv="Content-Security-Policy">` in static HTML
- Cloudflare / Vercel edge functions setting headers

Plan the additions:

- `script-src`: add `https://*.posthog.com`
- `connect-src`: add `https://*.posthog.com` (and the reverse proxy path if used — usually same-origin so already allowed)
- `img-src`: add `https://*.posthog.com` if session replay or surveys will use PostHog-hosted images

If using the reverse proxy (recommended), the connect target is same-origin (`/ingest`), which most CSPs already allow. But the SDK assets are still loaded from `*.posthog.com` unless you proxy `array` and `static` too (which the recipes do).

### Notes

- Strict CSPs that use nonces are fine; PostHog's SDK doesn't inline scripts.
- If the CSP has `report-uri` or `report-to`, the user will see warnings during validation if any directive is missed.

---

## Discovery Report template

When all six dimensions are filled, write a Discovery Report to the conversation (not to disk) in this shape:

```
## Discovery Report

**Stack**
- Framework: <e.g. Next.js 15.3.0 App Router>
- Package manager: <e.g. pnpm>
- TypeScript: <yes/no>
- Existing analytics: <none | Sentry | etc.>

**Auth**
- Provider: <e.g. Supabase>
- Signup completes at: <file:line>
- Signin completes at: <file:line>
- OAuth callback at: <file:line>
- Email confirmation: <required | not required>

**Billing**
- Provider: <e.g. Stripe | none>
- Webhook handler: <file:line | n/a>
- Checkout entry point: <file:line | n/a>

**Core product actions** (3–7)
1. <action_name> — <file:function>
2. ...

**Proposed env vars** (matching your <pattern> convention)
- <NEXT_PUBLIC_POSTHOG_TOKEN> (client)
- <NEXT_PUBLIC_POSTHOG_HOST> (client, optional, defaults to https://us.i.posthog.com)

**CSP changes**
- script-src += https://*.posthog.com
- connect-src += https://*.posthog.com
- (or "no CSP detected; none needed")

**Reverse proxy path**
- Default: /ingest
- PostHog recommends a unique path for ad-blocker resilience. Use /ingest, /a, /e, /m, or a random string?
```

Stop. Wait for the user to approve before moving to Phase 2.
