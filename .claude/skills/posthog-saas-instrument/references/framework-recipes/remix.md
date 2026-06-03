# Remix — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/remix
```

## Install

```bash
<package_manager> add posthog-js posthog-node
```

## Env vars

Remix exposes env vars through the root loader. PostHog's public token has to be passed from server → client:

```
POSTHOG_TOKEN=phc_xxxxx
POSTHOG_HOST=https://us.i.posthog.com
```

## Root loader exposes env to the client

`app/root.tsx`:

```tsx
import { json, type LoaderFunctionArgs } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'

export const loader = async ({ context }: LoaderFunctionArgs) => {
  return json({
    ENV: {
      POSTHOG_TOKEN: process.env.POSTHOG_TOKEN,
      POSTHOG_HOST: process.env.POSTHOG_HOST,
    },
  })
}

export default function App() {
  const data = useLoaderData<typeof loader>()
  return (
    <html>
      <head>{/* meta, links */}</head>
      <body>
        <Outlet />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.ENV = ${JSON.stringify(data.ENV)}`,
          }}
        />
        <Scripts />
      </body>
    </html>
  )
}
```

## Client init

`app/entry.client.tsx`:

```tsx
import { startTransition, StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { RemixBrowser } from '@remix-run/react'
import posthog from 'posthog-js'

declare global {
  interface Window {
    ENV: { POSTHOG_TOKEN?: string; POSTHOG_HOST?: string }
  }
}

if (window.ENV.POSTHOG_TOKEN) {
  posthog.init(window.ENV.POSTHOG_TOKEN, {
    api_host: '/ingest',
    ui_host: window.ENV.POSTHOG_HOST || 'https://us.i.posthog.com',
    defaults: '2026-01-30',                  // verify against current docs
    capture_exceptions: true,
  })
}

startTransition(() => {
  hydrateRoot(document, <StrictMode><RemixBrowser /></StrictMode>)
})
```

## Reverse proxy

Remix doesn't have a built-in rewrites mechanism. Options:

- **Custom server** (Express/Fastify/Hono): add proxy middleware to route `/ingest/*` → PostHog hosts.
- **Vercel/Netlify**: use the platform's rewrites file (see [vite-spa.md](vite-spa.md)).
- **Cloudflare Pages**: use `_redirects`.

## Server captures

In loaders and actions, use a singleton `posthog-node` client with `flushAt: 1, flushInterval: 0`. Call `await client.shutdown()` before the loader/action returns to flush in serverless environments.

## Identify

In the auth callback action (`app/routes/auth.callback.tsx` or wherever the session is established), emit a script via `useLoaderData` that calls `posthog.identify` on the client. Or in `app/root.tsx`, watch `useLoaderData()` for user changes and identify in a top-level effect (the one place an effect is acceptable, because auth state is a subscription).
