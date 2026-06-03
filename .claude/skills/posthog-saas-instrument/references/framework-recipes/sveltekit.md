# SvelteKit — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/svelte
```

## Install

```bash
<package_manager> add posthog-js
```

For server captures (form actions, API routes), also:

```bash
<package_manager> add posthog-node
```

## Env vars

SvelteKit splits env into public/private. PostHog client token goes in public:

```
PUBLIC_POSTHOG_TOKEN=phc_xxxxx
PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

Import via `$env/static/public`:

```ts
import { PUBLIC_POSTHOG_TOKEN, PUBLIC_POSTHOG_HOST } from '$env/static/public'
```

## Client init in the root layout

`src/routes/+layout.ts` (or `+layout.svelte` for client-only logic):

```ts
// src/routes/+layout.ts
import { browser } from '$app/environment'
import { PUBLIC_POSTHOG_TOKEN, PUBLIC_POSTHOG_HOST } from '$env/static/public'
import posthog from 'posthog-js'

export const load = async () => {
  if (browser && PUBLIC_POSTHOG_TOKEN) {
    posthog.init(PUBLIC_POSTHOG_TOKEN, {
      api_host: '/ingest',
      ui_host: PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      defaults: '2026-01-30',                    // verify against current docs
      capture_exceptions: true,
      capture_pageview: false,                   // we capture on navigation below
    })
  }
  return {}
}
```

And in `+layout.svelte`, capture `$pageview` on navigation:

```svelte
<script lang="ts">
  import { afterNavigate } from '$app/navigation'
  import { browser } from '$app/environment'
  import posthog from 'posthog-js'

  afterNavigate(() => {
    if (browser) posthog.capture('$pageview')
  })
</script>

<slot />
```

## Reverse proxy

SvelteKit's adapter handles this. For `@sveltejs/adapter-node` or `@sveltejs/adapter-vercel`, use the platform's rewrite config (e.g. `vercel.json`, see [vite-spa.md](vite-spa.md) for the JSON shape).

For `@sveltejs/adapter-static`, there's no server — same trade-off as the SPA recipe. Use direct host or platform proxy.

## Server captures

In `+page.server.ts` form actions or `+server.ts` API routes:

```ts
import { PostHog } from 'posthog-node'
import { PUBLIC_POSTHOG_TOKEN, PUBLIC_POSTHOG_HOST } from '$env/static/public'

let client: PostHog | null = null
function getClient() {
  if (client) return client
  if (!PUBLIC_POSTHOG_TOKEN) return null
  client = new PostHog(PUBLIC_POSTHOG_TOKEN, {
    host: PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
  })
  return client
}
```

## Identify

After auth completes (Lucia session, Auth.js callback, Supabase listener), call `posthog.identify(userId, traits)`. Keep it out of `useEffect`-style reactive statements that re-fire.
