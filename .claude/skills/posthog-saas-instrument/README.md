# posthog-superpower

A Claude Code skill that adds PostHog product analytics to **any** web app — Next.js, Vite/React SPA, Vue/Nuxt, SvelteKit, Remix, Rails, Django, Laravel, Express, or plain HTML — by first **discovering** the project's shape, then instrumenting end-to-end to match.

The skill registers as `posthog-saas-instrument` (its internal name). The repo is called `posthog-superpower` because that's what it gives you: from "no analytics" to "fully instrumented SaaS" in one session.

## Why this exists

Most "add analytics" guides assume you know the framework, the auth flow, the billing webhooks, where to identify users, what events to capture, and how to set up a reverse proxy for ad-blocker resilience. They also assume you've already decided on an event taxonomy.

Most teams add analytics by sprinkling `posthog.capture` calls in random spots, missing the auth and billing surfaces, and ending up with a per-page-load `useEffect` capture that double-counts on every render. Six months later, the funnels don't work and nobody trusts the data.

This skill is the opinionated, discovery-first alternative.

## How it works (six phases)

1. **Discovery (read-only).** Inspects the repo to identify framework, auth flow, billing surface, core product actions, env-var conventions, and CSP setup. Outputs a Discovery Report. You approve.
2. **Event taxonomy proposal.** Maps discovered call sites to a canonical SaaS event vocabulary (`user_signed_up`, `<action>_started/_completed/_failed`, `subscription_activated`, etc.) with distinct-id rules and property schemas. You approve or edit.
3. **Installation.** Installs the appropriate PostHog SDK using your detected package manager. Sets up client init, server-side singleton, reverse proxy for ad-blocker resilience, CSP additions, and env-var wiring matching your existing patterns.
4. **Instrumentation.** Places `posthog.capture` calls at event handlers (never `useEffect`), `posthog.identify` immediately after auth completes, and explicit `distinctId` on all server-side captures.
5. **Validation.** Runs build, typecheck, and a smoke test confirming the SDK actually loads and fires.
6. **Report.** Writes `posthog-setup-report.md` to the repo: files changed, events instrumented, env vars to set in hosting, dashboard suggestions, anything skipped and why.

Each phase commits independently with `posthog:` prefix so anything can be reverted cleanly.

## Hard rules the skill enforces

- **Discovery before code.** No edits until you've approved the Discovery Report and the event taxonomy.
- **Fetch docs at run time.** Before touching any PostHog API, the skill `WebFetch`es the current docs page for the detected framework. Training data lies; the SDK changes.
- **No secrets in code.** Only the publishable client token gets a `NEXT_PUBLIC_*` (or framework equivalent). Never inline. Never commit a `.env` file.
- **Optional by default.** If the token env var is missing, the integration no-ops gracefully (warns once, skips init, stubs the server client). Staging and local dev frequently run without a token.
- **Match existing conventions.** Package manager (`pnpm > yarn > npm > bun`), env-var pattern, import style, file layout. Conform; don't fork.
- **No `useEffect` for analytics captures.** Capture in event handlers where the action actually happens.
- **One commit per phase.** Easy revert. Easy audit.
- **Don't duplicate existing tooling.** If Sentry / Segment / GA is already there, slot alongside; don't replace.

## Install

The repo is `posthog-superpower`. The skill's internal name (and the directory it should live in for Claude Code to find it) is `posthog-saas-instrument`:

```bash
git clone https://github.com/jIrwinCline/posthog-superpower.git \
  ~/.claude/skills/posthog-saas-instrument
```

That's it. Claude Code reads the directory by its name; the frontmatter inside `SKILL.md` registers the skill as `posthog-saas-instrument`.

For project-local install (only available in one repo):

```bash
git clone https://github.com/jIrwinCline/posthog-superpower.git \
  .claude/skills/posthog-saas-instrument
```

## Usage

In any repo, ask Claude Code in plain English. The skill triggers on phrases like:

- "add PostHog"
- "set up product analytics"
- "instrument analytics"
- "track events"
- "add analytics tracking to this app"

You'll get the Discovery Report first. Read it, edit if anything looks off, then approve. The skill walks the remaining phases and asks before each commit.

## Supported stacks

The skill includes recipe files for:

- Next.js 15.3+ (App Router) — full templates, verified against current PostHog docs at the time of writing
- Next.js (Pages Router) — skeleton + runtime doc verification
- Vite + React (or CRA) — skeleton + runtime doc verification
- Nuxt 3+ — skeleton + runtime doc verification
- SvelteKit — skeleton + runtime doc verification
- Remix — skeleton + runtime doc verification
- Plain HTML / static sites — full snippet
- Ruby on Rails — full Ruby SDK pattern
- Django — full Python SDK pattern

For frameworks not listed (Laravel, Express, Flask, Sinatra, etc.), the skill fetches the relevant PostHog docs page at runtime and follows the listed recipes structurally.

The non-Next.js recipes are deliberately skeletons rather than full transcriptions because the skill's own Hard Rule 2 says "the SDK changes; training data lies." Baked-in exhaustive templates go stale; the skeleton + WebFetch pattern stays current.

## Files this skill produces in your repo

| File | Purpose |
|---|---|
| `posthog-setup-report.md` | The Phase 6 report: what changed, what to do next, what was skipped |

Plus code edits per the framework recipe (see each recipe in `references/framework-recipes/` for the file list) and git commits prefixed `posthog:`:

```bash
git log --grep="posthog:" --oneline
```

## Project structure

```
posthog-superpower/
├── SKILL.md                                # the manifest (what Claude reads)
├── README.md                                # you are here
├── LICENSE                                  # MIT
└── references/
    ├── discovery-checklist.md               # Phase 1 template
    ├── event-taxonomy.md                    # canonical SaaS event vocabulary
    └── framework-recipes/
        ├── nextjs-app-router.md             # full templates (verified)
        ├── nextjs-pages-router.md
        ├── vite-spa.md
        ├── nuxt.md
        ├── sveltekit.md
        ├── remix.md
        ├── static-html.md
        ├── rails.md
        └── django.md
```

## Sibling skills worth knowing

PostHog publishes their own Claude Code skills via a plugin. Worth installing if you use PostHog beyond product analytics:

- `posthog:instrument-product-analytics` — narrower scope: adds capture calls to existing features. This skill is the full setup-from-zero counterpart.
- `posthog:instrument-error-tracking` — exception capture setup
- `posthog:instrument-feature-flags` — feature flags rollout
- `posthog:instrument-llm-analytics` — LLM-specific tracing

If you only want to add captures to one already-instrumented feature, use `posthog:instrument-product-analytics`. This skill is for "go from zero to fully instrumented."

## Philosophy

The skill is deliberately discovery-first. It proposes; you approve; it applies. It will not start editing your codebase based on assumptions about your stack. It will not invent an event taxonomy without showing it to you first. It will not silently overwrite your existing CSP, env-var schema, or rewrite rules.

A wrong taxonomy is harder to undo than a missing one. A `useEffect` capture that double-counts is worse than no capture. The skill is built to give you a working, opinionated baseline you can actually trust, not the maximum number of `posthog.capture` calls inserted in the shortest amount of time.

## License

MIT. See [LICENSE](LICENSE).
