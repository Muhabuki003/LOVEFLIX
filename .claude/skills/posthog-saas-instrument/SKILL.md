---
name: posthog-saas-instrument
description: Discovers the structure of any SaaS or website (framework, auth flow, billing, key user actions, API routes, webhooks) and adds PostHog analytics end-to-end — client init, server-side capture, identify on auth, reverse proxy for ad-blocker resilience, env-var wiring, and a canonical SaaS event taxonomy. Use when the user says "add PostHog", "instrument analytics", "set up product analytics", or "track events".
---

# posthog-saas-instrument

Add PostHog product analytics to any web app, end to end. Works against any stack — Next.js, React SPA, Vue/Nuxt, SvelteKit, Remix, Rails, Django, Laravel, Express, or plain HTML — by discovering the project's shape first, then instrumenting to match.

The skill runs six phases. Phases 1–2 produce no commits (read-only discovery + taxonomy approval). Phases 3–6 each commit independently with clear messages so anything can be reverted cleanly.

## Sibling skills worth knowing

- **`posthog:instrument-product-analytics`** (PostHog plugin) — narrower scope; adds capture calls to existing features. This skill is the full setup-from-zero counterpart.
- **`posthog:instrument-error-tracking`** — for exception capture if that's the goal.
- **`posthog:instrument-feature-flags`** — for feature flags rollout.
- **`posthog:instrument-llm-analytics`** — for LLM-specific tracing.

If the user only wants to add captures to one already-instrumented feature, redirect to `posthog:instrument-product-analytics`. This skill is for "go from zero to fully instrumented."

## Hard rules

These exist because the skill's job is to leave the codebase in a known-good state. Every shortcut here has bitten somebody.

1. **Discovery before code.** Never start editing in Phase 3 until the Phase 1 Discovery Report and Phase 2 taxonomy have been shown to the user and approved. Editing without approval means burning their trust and your token budget.
2. **Fetch docs at run time.** Before touching any PostHog API for any framework, `WebFetch` the relevant page on `posthog.com/docs/libraries/<framework>` (or `posthog.com/docs/advanced/proxy/<framework>` for proxy work). The SDK changes; training data lies. Every framework recipe in `references/framework-recipes/` includes the canonical URL to fetch.
3. **No secrets in code.** Only `NEXT_PUBLIC_*` (or framework equivalent for client-exposed variables) gets the project token. Never inline. Never commit a `.env` file. Read [memory: J never reads .env files; ask the user which vars are defined if you need to know].
4. **Match existing conventions.** Package manager (pnpm > yarn > npm > bun, by lockfile), env-var pattern, import style, file layout. Conform; don't fork. If the project uses a Zod env schema, add to it; don't create a parallel one.
5. **Optional by default.** When the token env var is missing, the integration must no-op gracefully (warn once, skip init, stub server client). Staging and local dev frequently run without a token.
6. **Don't duplicate existing tooling.** If Sentry, Segment, Mixpanel, GA, or Datadog is already installed, slot PostHog alongside; don't replace. The user picked the other tool deliberately at some point.
7. **No `useEffect` for analytics captures.** Capture in event handlers where the action actually happens. `useEffect` fires on remounts, on hot-reloads, and on dev rerenders; it pollutes the data and double-counts.
8. **One commit per phase.** Phase 1 produces no commit (read-only). Phases 3, 4, 5, 6 each commit independently. Commit subjects: `posthog: <phase>: <what>`.
9. **Server captures need explicit `distinctId`.** Server-side captures inside webhooks, route handlers, server actions, or background jobs have no implicit user. Always pass `distinctId` explicitly (user id, or org id if no user is in scope).
10. **Short-lived server contexts must flush.** Inside serverless functions, route handlers, or any short-lived process, either call `await posthog.shutdown()` before return, or rely on the singleton being created with `flushAt: 1, flushInterval: 0` (which is what `references/framework-recipes/nextjs-app-router.md` and equivalents specify).

## Phase 1 — Discovery (read-only)

Walk the repo to fill in the template at [references/discovery-checklist.md](references/discovery-checklist.md). Use `Glob`, `Grep`, `Read`. Do not edit.

Six dimensions, in order:

1. **Stack** — read `package.json` / `requirements.txt` / `Gemfile` / `composer.json` / `go.mod`. Identify framework + version. Detect package manager from lockfile. Detect existing analytics/error tooling (Sentry, Datadog, GA, Segment, Mixpanel) so PostHog slots in alongside.

2. **Auth surface** — grep for `signIn`, `signUp`, `signin`, `signup`, `login`, `register`, `auth/callback`, `oauth`, `magic-link`, `supabase.auth`, `next-auth`, `clerk`, `auth0`, `firebase.auth`, `lucia`, `better-auth`. Identify where signup completes, where signin completes, where OAuth callbacks land (almost always a server route), and whether email confirmation is required.

3. **Billing / monetization surface** — grep for `stripe`, `paddle`, `lemonsqueezy`, `chargebee`, `webhook`, `checkout.session.completed`, `customer.subscription.*`, `invoice.payment_failed`. Identify webhook handlers (server-only), checkout entry points, subscription-state writes.

4. **Core product surface** — list all API routes / server actions / controllers. List all forms (`<form onSubmit>`, server actions, mutation hooks). Identify the 3–7 actions that represent the product's core value (e.g. "create a thing", "export a thing", "share a thing"). If ambiguous, ask the user to rank.

5. **Env-var conventions** — look at how the project already loads env vars: `.env.local`, `process.env.NEXT_PUBLIC_*`, Zod schema in `src/lib/env.ts`, Vite's `import.meta.env.VITE_*`, Rails credentials, Django `settings.py`. Match the existing pattern. Do not introduce a new convention.

6. **CSP / security headers** — read `next.config.*`, `vercel.json`, `helmet` config, Rails `content_security_policy`, or static `<meta http-equiv="Content-Security-Policy">` tags. Plan exact `script-src` / `connect-src` additions for `*.posthog.com`.

**Output of Phase 1**: a `Discovery Report` shown to the user (in-conversation, not committed) covering stack, auth flow, billing flow, candidate events, proposed env-var names, and CSP changes needed. Stop. Wait for approval.

## Phase 2 — Event taxonomy proposal

Propose a canonical SaaS event taxonomy mapped to the call sites discovered in Phase 1. See [references/event-taxonomy.md](references/event-taxonomy.md) for the full vocabulary, per-event property schemas, and the "what and why, not how" naming rule.

Show the user a table:

| Event | When (file:function) | Client/Server | distinctId source | Key properties |
|---|---|---|---|---|

Stop. Wait for approval. Anything the user wants to add, rename, or drop happens here; not later.

## Phase 3 — Installation

Implement the integration per the recipe for the discovered stack:

- Next.js App Router (15.3+) → [references/framework-recipes/nextjs-app-router.md](references/framework-recipes/nextjs-app-router.md)
- Next.js Pages Router → [references/framework-recipes/nextjs-pages-router.md](references/framework-recipes/nextjs-pages-router.md)
- Vite + React SPA / CRA → [references/framework-recipes/vite-spa.md](references/framework-recipes/vite-spa.md)
- Nuxt → [references/framework-recipes/nuxt.md](references/framework-recipes/nuxt.md)
- SvelteKit → [references/framework-recipes/sveltekit.md](references/framework-recipes/sveltekit.md)
- Remix → [references/framework-recipes/remix.md](references/framework-recipes/remix.md)
- Static HTML → [references/framework-recipes/static-html.md](references/framework-recipes/static-html.md)
- Rails → [references/framework-recipes/rails.md](references/framework-recipes/rails.md)
- Django → [references/framework-recipes/django.md](references/framework-recipes/django.md)

For frameworks not listed (Laravel, Express, Flask, Sinatra, etc.), `WebFetch` `https://posthog.com/docs/libraries/<framework>` and follow that page. Use the listed recipes as structural references.

Every recipe begins with a `WebFetch` instruction — run it before writing code. Hard Rule 2.

After install, commit: `posthog: install SDK + reverse proxy + env wiring`.

## Phase 4 — Instrumentation

For each approved event in the taxonomy:

- Place `posthog.capture(event, props)` (client) or `posthog.capture({ distinctId, event, properties })` (server) at the call site where the action *completes*, not where it begins. Never in a `useEffect`, never in middleware, never at module top level.
- Place `posthog.identify(userId, traits)` immediately after the user becomes known: signup success, signin success, OAuth callback handler.
- For webhooks and server actions, pass `distinctId` explicitly.
- For server captures inside serverless functions, either `await posthog.shutdown()` before return or rely on the singleton's `flushAt: 1, flushInterval: 0` config.

Commit: `posthog: instrument <N> events across <files>`.

## Phase 5 — Validation

Before declaring done:

1. Run the project's build (`pnpm build`, `npm run build`, `bin/rails assets:precompile`, `python manage.py check`, framework equivalent). Surface any failure; do not move on with a red build.
2. Run typecheck if the project has one (`pnpm typecheck`, `tsc --noEmit`, `mypy .`).
3. Start the dev server (`pnpm dev`, `npm run dev`, framework equivalent). Verify a network request fires to `/ingest` (or the configured proxy path, or the direct host). If headless/no browser available, grep the bundled output for `posthog.init` as a fallback.
4. List the capture call sites added and the events they emit.

Commit: `posthog: validate build + smoke test`.

## Phase 6 — Report

Write `posthog-setup-report.md` at the repo root containing:

- **Files created/edited** (table: file, action, purpose)
- **Events instrumented** (table: event, description, file:line, client-or-server, distinctId source)
- **Env vars to set** in hosting (Vercel/Render/Fly/Heroku/etc.), with which ones are public and which are server-only
- **CSP changes made** if applicable, with before/after
- **Suggested dashboards/insights to build** in PostHog (funnels, retention, conversion to paid)
- **Anything skipped and why** (e.g. "no billing detected; no subscription events added")

Commit: `posthog: setup report`.

## Output files in the target repo

- `posthog-setup-report.md` — the Phase 6 report
- Code edits per the framework recipe (see each recipe for the file list)
- Git commits prefixed `posthog:` for one-line audit via `git log --grep="posthog:"`
