# Next.js App Router (15.3+) — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/next-js
WebFetch https://posthog.com/docs/advanced/proxy/nextjs
```

The SDK changes; the `defaults` snapshot date and the `instrumentation-client.ts` mechanism are both relatively new (Next 15.3+). If the fetched docs differ from this recipe, follow the docs.

## Preconditions

- Next.js **>= 15.3.0** (older versions need a different client-init mechanism — see [nextjs-pages-router.md](nextjs-pages-router.md) or use the `app/PostHogProvider.tsx` pattern from the older docs).
- App Router enabled (`src/app/` or `app/` directory present, not `src/pages/`).

## Step 1 — Install

Use the detected package manager (Hard Rule 4):

```bash
# pnpm
pnpm add posthog-js posthog-node

# npm
npm install posthog-js posthog-node

# yarn
yarn add posthog-js posthog-node

# bun
bun add posthog-js posthog-node
```

## Step 2 — Environment variables

Add to `.env.local` (and `.env.local.example` if it exists; never commit `.env.local`):

```
NEXT_PUBLIC_POSTHOG_TOKEN=phc_xxxxx
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

If the project uses a Zod env schema (`src/env.mjs`, `src/lib/env.ts`, `@t3-oss/env-nextjs`), add to the schema instead of reading `process.env` directly. Example for `@t3-oss/env-nextjs`:

```ts
// src/env.mjs (snippet)
client: {
  NEXT_PUBLIC_POSTHOG_TOKEN: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional().default('https://us.i.posthog.com'),
},
```

Mark optional so dev/staging without a token doesn't crash boot.

## Step 3 — Client init

Create `instrumentation-client.ts` at the **project root** (not in `app/`, not in `src/`):

```ts
// instrumentation-client.ts
import posthog from 'posthog-js'

const token = process.env.NEXT_PUBLIC_POSTHOG_TOKEN

if (token) {
  posthog.init(token, {
    api_host: '/ingest',                              // reverse proxy, see Step 4
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.posthog.com',
    defaults: '2026-01-30',                            // PostHog config snapshot; bump per docs
    capture_exceptions: true,                          // PostHog exception capture
    debug: process.env.NODE_ENV === 'development',
  })
} else if (process.env.NODE_ENV === 'development') {
  console.warn('[posthog] NEXT_PUBLIC_POSTHOG_TOKEN not set; analytics disabled')
}
```

**Verify the `defaults` snapshot date** against the current docs (`WebFetch https://posthog.com/docs/libraries/next-js`). PostHog updates this periodically.

## Step 4 — Reverse proxy in `next.config.*`

The reverse proxy lets PostHog requests look like same-origin traffic, which dodges most ad blockers and removes a third-party DNS lookup. PostHog recommends a non-obvious path; `/ingest` is the default but you can use anything (`/a`, `/_p`, etc.).

Add to `next.config.{js,mjs,ts}`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // ... existing config ...

  skipTrailingSlashRedirect: true,

  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/array/:path*',
        destination: 'https://us-assets.i.posthog.com/array/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
    ]
  },
}

module.exports = nextConfig
```

**Order matters.** The `/static` and `/array` rewrites must come before the catch-all `/ingest/:path*`. Next.js evaluates rewrites in order.

**Region**: replace `us` with `eu` if the PostHog project is in the EU region.

**If `rewrites()` already exists** in `next.config`, merge into the returned array; don't overwrite. If `skipTrailingSlashRedirect` is already set to `false`, surface this to the user — changing it could affect other behavior.

## Step 5 — CSP additions

If the project sets a Content-Security-Policy header (check `next.config` `headers()`, `middleware.ts`, or `vercel.json`), add:

- `script-src`: append ` https://*.posthog.com`
- `connect-src`: append ` https://*.posthog.com`
- `img-src`: append ` https://*.posthog.com` (only if session replay is used)

If you're using the reverse proxy (Step 4), `connect-src` typically already allows same-origin (`'self'`), so the connect addition is only strictly needed if direct PostHog hits could happen (e.g. session replay assets). Add it anyway for safety.

## Step 6 — Server-side client

Create `src/lib/posthog-server.ts` (or `lib/posthog-server.ts` if no `src/` directory):

```ts
// src/lib/posthog-server.ts
import { PostHog } from 'posthog-node'

let posthogClient: PostHog | null = null

/**
 * Returns a singleton PostHog server client.
 * Returns a stub with a no-op `capture` when the token is unset, so call sites never crash in dev/staging.
 */
export function getPostHogClient(): { capture: (args: { distinctId: string; event: string; properties?: Record<string, unknown> }) => void; shutdown: () => Promise<void> } {
  if (posthogClient) return posthogClient

  const token = process.env.NEXT_PUBLIC_POSTHOG_TOKEN
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'

  if (!token) {
    return {
      capture: () => {},
      shutdown: async () => {},
    }
  }

  posthogClient = new PostHog(token, {
    host,
    flushAt: 1,        // serverless: flush every event immediately
    flushInterval: 0,  // serverless: don't batch on a timer
  })

  return posthogClient
}
```

**Usage in a route handler:**

```ts
// src/app/api/notes/route.ts
import { getPostHogClient } from '@/lib/posthog-server'

export async function POST(req: Request) {
  const { userId, ...body } = await req.json()
  const note = await db.note.create({ data: body })

  const posthog = getPostHogClient()
  posthog.capture({
    distinctId: userId,
    event: 'note_created',
    properties: { word_count: note.body.split(/\s+/).length, template_used: body.template },
  })
  await posthog.shutdown()  // serverless: flush before return

  return Response.json(note)
}
```

In long-running processes (custom Node server, edge runtime), the `shutdown()` call is not required after every capture; let the singleton batch naturally.

## Step 7 — Identify the user

The single biggest leverage point. Without `identify`, every event is anonymous and you can't build user-level funnels.

**Where to call it** depends on the auth provider. Examples:

- **Supabase**: in a top-level client component, subscribe to `onAuthStateChange` and call `posthog.identify(session.user.id, { email, ...traits })` on `SIGNED_IN`. Call `posthog.reset()` on `SIGNED_OUT`.
- **NextAuth**: in a `SessionProvider` wrapper, watch `session.status === 'authenticated'` and call `identify` once per session.
- **Clerk**: in a `useUser`-driven effect, identify when `isSignedIn` flips to true.
- **Custom**: at the call site that completes signin/signup (form handler, OAuth callback).

Example (Supabase):

```tsx
// src/components/posthog-identify.tsx
'use client'
import { useEffect } from 'react'
import posthog from 'posthog-js'
import { createClient } from '@/lib/supabase/client'

export function PostHogIdentify() {
  useEffect(() => {
    const supabase = createClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        posthog.identify(session.user.id, {
          email: session.user.email,
        })
      } else if (event === 'SIGNED_OUT') {
        posthog.reset()
      }
    })
    return () => subscription.unsubscribe()
  }, [])
  return null
}
```

Mount once in `app/layout.tsx`.

**Hard Rule 7 reminder**: don't put the actual `posthog.capture` calls in `useEffect`. Identify in an effect (because auth state is a subscription), but capture in event handlers.

## Files touched (summary)

| File | Action |
|---|---|
| `package.json` + lockfile | added `posthog-js`, `posthog-node` |
| `.env.local` | added `NEXT_PUBLIC_POSTHOG_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST` |
| `.env.local.example` (if exists) | mirrored the above with placeholder values |
| `src/env.mjs` or `src/lib/env.ts` (if exists) | added to schema |
| `instrumentation-client.ts` (project root) | created |
| `next.config.{js,mjs,ts}` | added `skipTrailingSlashRedirect`, `rewrites()` |
| CSP location (if exists) | added `*.posthog.com` to `script-src`, `connect-src` |
| `src/lib/posthog-server.ts` | created |
| `src/components/posthog-identify.tsx` | created (provider-specific) |
| `src/app/layout.tsx` | mounted `<PostHogIdentify />` |

## Common gotchas

- **`defaults` snapshot is stale by next year.** Re-check the docs annually.
- **Edge runtime + `posthog-node`** can be flaky; some serverless platforms (Vercel Edge, Cloudflare Workers) don't fully support the Node SDK. For edge routes, use direct `fetch` to the PostHog capture endpoint, or move analytics-critical work to the Node runtime.
- **Reverse proxy + Next.js middleware**: middleware runs *before* rewrites. If middleware redirects on `/ingest/*`, PostHog requests die. Exclude `/ingest/` from middleware matcher.
- **Multiple region projects**: if the project is in the PostHog EU region, change all `us` hosts to `eu`.
- **Local dev with `next dev --turbo`**: instrumentation-client works in turbo mode as of Next 15.3 but verify during validation.
