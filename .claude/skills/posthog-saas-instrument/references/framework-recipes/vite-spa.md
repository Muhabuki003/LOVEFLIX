# Vite + React SPA (and CRA) — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/react
WebFetch https://posthog.com/docs/libraries/js
```

## Install

```bash
<package_manager> add posthog-js
```

(No `posthog-node` — SPAs are client-only. If the project has a separate backend, instrument that with the appropriate server SDK as a follow-up.)

## Env vars

Vite uses `import.meta.env.VITE_*`. CRA uses `process.env.REACT_APP_*`.

```
# Vite
VITE_POSTHOG_TOKEN=phc_xxxxx
VITE_POSTHOG_HOST=https://us.i.posthog.com

# CRA
REACT_APP_POSTHOG_TOKEN=phc_xxxxx
REACT_APP_POSTHOG_HOST=https://us.i.posthog.com
```

Add to `.env` (gitignored) and `.env.example`.

## Client init

`src/main.tsx` (Vite) or `src/index.tsx` (CRA):

```tsx
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'

const token = import.meta.env.VITE_POSTHOG_TOKEN  // CRA: process.env.REACT_APP_POSTHOG_TOKEN

if (token) {
  posthog.init(token, {
    api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
    defaults: '2026-01-30',                        // verify against current docs
    capture_exceptions: true,
    debug: import.meta.env.DEV,
  })
}

createRoot(document.getElementById('root')!).render(
  <PostHogProvider client={posthog}>
    <App />
  </PostHogProvider>
)
```

## Reverse proxy

SPAs typically don't have a Node server to proxy through. Options:

1. **No proxy** — accept the ad-blocker hit. Direct `*.posthog.com` calls. Simplest.
2. **Proxy via the SPA's hosting platform** — Vercel rewrites in `vercel.json`, Netlify `_redirects`, Cloudflare Workers. Same three-rewrite pattern as Next.js but defined at the platform level. Example `vercel.json`:

```json
{
  "rewrites": [
    { "source": "/ingest/static/:path*", "destination": "https://us-assets.i.posthog.com/static/:path*" },
    { "source": "/ingest/array/:path*", "destination": "https://us-assets.i.posthog.com/array/:path*" },
    { "source": "/ingest/:path*", "destination": "https://us.i.posthog.com/:path*" }
  ]
}
```

If using a platform proxy, set `api_host: '/ingest'` in `posthog.init`. Otherwise use the direct host.

## React Router pageviews

If using React Router, capture `$pageview` on route change. PostHog's React SDK provides hooks; check the React docs page.

## Identify the user

Wherever auth completes (the `useAuth().signIn` success handler, the Clerk `useUser` hook reacting to `isSignedIn`, the Supabase `onAuthStateChange` listener): call `posthog.identify(userId, traits)`. Once per session.

## Gotchas

- `import.meta.env.VITE_*` must be defined at build time, not runtime. If the token rotates, the SPA needs a rebuild.
- CRA is deprecated; if the project is on CRA, consider migrating to Vite as a separate task. Don't bundle that migration into PostHog setup.
