// PostHog client init + small helper API for LoveFlix.
//
// Loads its config from /api/posthog-config (mirrors the /api/stripe-config
// and /api/maps-config pattern) so the project key isn't hardcoded into
// every HTML file. When the key is missing the integration silently no-ops
// — staging and local dev frequently run without a token.
//
// Capture/identify call sites live in assets/loveflix.js (auth) and in the
// per-page handlers (player.html, checkout.html, etc.). This file is just
// the loader + a thin window.LoveFlixAnalytics wrapper that queues calls
// until the SDK is ready.
(function () {
  'use strict';

  // ---- PostHog snippet (canonical array-stub loader) ----------------------
  // Verified against https://posthog.com/docs/libraries/js — this stub is
  // the most stable cross-version surface; PostHog rewrites the script host
  // (us.i → us-assets.i) at runtime.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  var INITIALIZED = false;
  var DISABLED = false;
  var pendingIdentify = null; // { id, traits } captured before init resolves
  var pendingGroup = null;    // { type, key, traits }

  function debug(msg) {
    if (window.LOVEFLIX_DEBUG) console.log('[posthog]', msg);
  }

  function init(key, host) {
    if (INITIALIZED || DISABLED) return;
    if (!key) { DISABLED = true; debug('no key configured; analytics disabled'); return; }
    try {
      window.posthog.init(key, {
        // Routes captures through this site so ad-blockers don't drop them.
        // Matches the /ingest/* proxy in functions/ingest/[[path]].js.
        api_host: '/ingest',
        ui_host: (host || 'https://us.i.posthog.com').replace('.i.posthog.com', '.posthog.com'),
        person_profiles: 'identified_only',
        capture_pageview: true,
        capture_pageleave: true,
        disable_session_recording: false,
      });
      INITIALIZED = true;
      // Replay anything queued before init resolved.
      if (pendingIdentify) {
        window.posthog.identify(pendingIdentify.id, pendingIdentify.traits);
        pendingIdentify = null;
      }
      if (pendingGroup) {
        window.posthog.group(pendingGroup.type, pendingGroup.key, pendingGroup.traits);
        pendingGroup = null;
      }
    } catch (e) {
      debug('init failed: ' + (e && e.message));
      DISABLED = true;
    }
  }

  // Fetch the public config from our own API. We don't inline the key into
  // every HTML page; that would mean 20+ files to update on rotation.
  fetch('/api/posthog-config', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg || !cfg.key) { DISABLED = true; return; }
      init(cfg.key, cfg.host);
    })
    .catch(function () { DISABLED = true; });

  // ---- LoveFlix-shaped helper API ----------------------------------------
  // All callers go through window.LoveFlixAnalytics so call sites don't
  // touch window.posthog directly and we can swap implementations cleanly.
  window.LoveFlixAnalytics = {
    capture: function (event, props) {
      if (DISABLED) return;
      // The posthog stub queues calls before the real script loads, so we
      // can call through unconditionally — pre-init calls are flushed once
      // the array.js bundle takes over.
      try { window.posthog.capture(event, props || {}); } catch (e) { debug(e && e.message); }
    },
    identify: function (userId, traits) {
      if (DISABLED || !userId) return;
      if (!INITIALIZED) { pendingIdentify = { id: userId, traits: traits || {} }; return; }
      try { window.posthog.identify(userId, traits || {}); } catch (e) { debug(e && e.message); }
    },
    group: function (groupType, groupKey, traits) {
      if (DISABLED || !groupKey) return;
      if (!INITIALIZED) { pendingGroup = { type: groupType, key: groupKey, traits: traits || {} }; return; }
      try { window.posthog.group(groupType, groupKey, traits || {}); } catch (e) { debug(e && e.message); }
    },
    reset: function () {
      if (DISABLED || !INITIALIZED) return;
      try { window.posthog.reset(); } catch (e) { debug(e && e.message); }
    },
  };
})();
