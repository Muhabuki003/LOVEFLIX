# Next.js Pages Router — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/next-js
WebFetch https://posthog.com/docs/advanced/proxy/nextjs
```

The Pages Router init pattern differs from App Router (no `instrumentation-client.ts`; init goes in `_app.tsx`).

## Install

```bash
<package_manager> add posthog-js posthog-node
```

## Env vars

Same as App Router:

```
NEXT_PUBLIC_POSTHOG_TOKEN=phc_xxxxx
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

## Client init in `_app.tsx`

```tsx
// src/pages/_app.tsx
import { useEffect } from 'react'
import { useRouter } from 'next/router'
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_POSTHOG_TOKEN) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_TOKEN, {
    api_host: '/ingest',
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.posthog.com',
    defaults: '2026-01-30',                 // verify against current docs
    capture_pageview: false,                // we'll capture manually on route change
    capture_exceptions: true,
    debug: process.env.NODE_ENV === 'development',
  })
}

export default function App({ Component, pageProps }) {
  const router = useRouter()
  useEffect(() => {
    const handleRouteChange = () => posthog.capture('$pageview')
    router.events.on('routeChangeComplete', handleRouteChange)
    return () => router.events.off('routeChangeComplete', handleRouteChange)
  }, [router])
  return (
    <PostHogProvider client={posthog}>
      <Component {...pageProps} />
    </PostHogProvider>
  )
}
```

The manual `$pageview` capture on route change is necessary because client-side route changes in Pages Router don't trigger the default page load capture.

## Reverse proxy in `next.config.*`

Identical to App Router. See [nextjs-app-router.md](nextjs-app-router.md) Step 4.

## Server-side client

Identical to App Router. Create `src/lib/posthog-server.ts`. See [nextjs-app-router.md](nextjs-app-router.md) Step 6.

Use it in `pages/api/*.ts` route handlers and in `getServerSideProps`.

## Identify the user

In `_app.tsx`, watch the session and call `posthog.identify`. Provider-specific same as App Router.

## Gotchas

- `posthog.init` runs on every Hot Module Replacement in dev. The internal SDK is idempotent, but stray `console.warn` from re-init can be noisy.
- `getServerSideProps` runs on every request; if you `capture` there, you'll double-count with the client `$pageview`. Capture from one place only.
