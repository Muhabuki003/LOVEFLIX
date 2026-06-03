# Plain HTML / Static Sites — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/js
```

The snippet pattern is the most stable across PostHog versions. Verify the latest snippet anyway because the script URL host occasionally changes (us-assets vs us.i etc.).

## The snippet

Place in `<head>` of every page (or in a shared layout/partial if the site is built from a static site generator):

```html
<script>
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('phc_YOUR_TOKEN', {
    api_host: 'https://us.i.posthog.com',
    defaults: '2026-01-30'    // verify against current docs
  })
</script>
```

**Token placement on a static site**: there's no env-var system at runtime. Options:

1. **Inline the token** in the HTML. Project tokens are designed to be public; this is acceptable per PostHog's threat model.
2. **Build-time replacement** if the site uses a static site generator (Astro, Eleventy, Hugo, Jekyll) — use the SSG's env-var mechanism to inject at build.

## Pageviews

Auto-captured by default. No additional code.

## Custom events

```html
<button onclick="posthog.capture('cta_clicked', { cta_id: 'hero-primary' })">
  Sign Up
</button>
```

Or in a separate JS file:

```js
document.querySelector('#contact-form').addEventListener('submit', () => {
  posthog.capture('contact_form_submitted')
})
```

## Identify (if there's any user notion)

For a marketing site, this is rare. If there's a newsletter signup that returns the user's email:

```js
fetch('/api/newsletter', { method: 'POST', body: formData })
  .then(res => res.json())
  .then(data => {
    posthog.identify(data.email, { email: data.email, source: 'newsletter' })
    posthog.capture('newsletter_signed_up')
  })
```

## Reverse proxy

A static site usually doesn't have a server. Options:

- **Skip the proxy** — direct calls to `*.posthog.com`. Accept ad-blocker hit. Simplest.
- **Platform-level proxy** — Cloudflare Pages `_redirects`, Netlify `_redirects`, Vercel `vercel.json`. Same three-rewrite pattern as the Next.js recipe. Then change `api_host` in the snippet to `/ingest`.

## CSP

If the site has a `<meta http-equiv="Content-Security-Policy">` or the host sets a CSP header, add `https://*.posthog.com` to `script-src` and `connect-src`.
