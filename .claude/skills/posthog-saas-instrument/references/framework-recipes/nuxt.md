# Nuxt 3+ — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/nuxt-js
```

## Install

```bash
<package_manager> add posthog-js
```

For server-side capture (API routes, server middleware), also:

```bash
<package_manager> add posthog-node
```

## Env vars via `runtimeConfig`

`nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  runtimeConfig: {
    posthogPersonalApiKey: '',       // server-only
    public: {
      posthogToken: '',              // exposed to client
      posthogHost: 'https://us.i.posthog.com',
    },
  },
})
```

Then in `.env`:

```
NUXT_PUBLIC_POSTHOG_TOKEN=phc_xxxxx
NUXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

Nuxt maps `NUXT_PUBLIC_POSTHOG_TOKEN` → `runtimeConfig.public.posthogToken` automatically.

## Client init via a plugin

`plugins/posthog.client.ts`:

```ts
import posthog from 'posthog-js'

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  if (!config.public.posthogToken) return

  const posthogClient = posthog.init(config.public.posthogToken, {
    api_host: '/ingest',
    ui_host: config.public.posthogHost,
    defaults: '2026-01-30',                    // verify against current docs
    capture_exceptions: true,
    capture_pageview: false,                   // we'll capture on route change
  })

  const router = useRouter()
  router.afterEach((to) => {
    nuxtApp.hook('page:finish', () => {
      posthog.capture('$pageview', { $current_url: to.fullPath })
    })
  })

  return { provide: { posthog: posthogClient } }
})
```

Use in components: `const { $posthog } = useNuxtApp(); $posthog?.capture('event_name')`.

## Reverse proxy

In `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  routeRules: {
    '/ingest/static/**': { proxy: 'https://us-assets.i.posthog.com/static/**' },
    '/ingest/array/**': { proxy: 'https://us-assets.i.posthog.com/array/**' },
    '/ingest/**': { proxy: 'https://us.i.posthog.com/**' },
  },
})
```

## Server captures

For Nitro server routes (`server/api/*.ts`), use `posthog-node` with the same singleton pattern as the Next.js recipe.

## Identify

In the auth completion handler (`useSupabaseUser` watcher, `useAuth().signIn` callback, etc.):

```ts
const { $posthog } = useNuxtApp()
$posthog?.identify(user.id, { email: user.email })
```
