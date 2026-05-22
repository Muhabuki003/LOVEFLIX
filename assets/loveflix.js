// LoveFlix shared client — Supabase auth + API helpers.
// Used by every page. Vanilla JS, no build step.
(function (global) {
  const SUPABASE_URL = 'https://jeblgjjutyzzdursjqnn.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplYmxnamp1dHl6emR1cnNqcW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMzY0NjgsImV4cCI6MjA5MzcxMjQ2OH0.X9YVrfLJ4JSIBdXVkpYegeZ5kEqJzkmzQ1P0d3tFoko';

  const TOKEN_KEY = 'loveflix_token';
  const REFRESH_KEY = 'loveflix_refresh_token';
  const USER_KEY = 'loveflix_user';
  const SETTINGS_KEY = 'loveflix_settings';
  // Mirror of settings written while unauthenticated (e.g. signup before email
  // confirm). Flushed to the server on the next successful sign-in.
  const PENDING_KEY = 'loveflix_pending_settings';
  // Client-side timestamp embedded inside the settings object. Used to resolve
  // local vs server conflicts on pull so a freshly-saved name is never
  // overwritten by stale server data.
  const TS_FIELD = '__updatedAt';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }
  function setSession({ access_token, refresh_token, user }) {
    if (access_token) localStorage.setItem(TOKEN_KEY, access_token);
    if (refresh_token) localStorage.setItem(REFRESH_KEY, refresh_token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    try { localStorage.removeItem('loveflix_couple_id'); } catch (_) {}
    try { localStorage.removeItem('loveflix_creator_id'); } catch (_) {}
    try { localStorage.removeItem('loveflix_role'); } catch (_) {}
    try { localStorage.removeItem(SETTINGS_KEY); } catch (_) {}
  }

  // Silently refresh the access token using the stored refresh token.
  // Returns true on success, false if there's nothing to refresh with.
  async function refreshSession() {
    const rt = localStorage.getItem(REFRESH_KEY);
    if (!rt) return false;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) { clearSession(); return false; }
      const data = await res.json();
      setSession(data);
      return true;
    } catch { return false; }
  }

  // Returns true if the stored access token is still valid (not expired).
  function isTokenFresh() {
    const token = getToken();
    if (!token) return false;
    try {
      const { exp } = JSON.parse(atob(token.split('.')[1]));
      // Treat as expired 60s early to avoid races
      return exp * 1000 > Date.now() + 60000;
    } catch { return false; }
  }

  // Ensures a fresh access token is in localStorage; refreshes if needed.
  // Call before any authenticated Supabase REST request.
  async function ensureFreshToken() {
    if (isTokenFresh()) return;
    await refreshSession();
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
  }

  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') || {}; }
    catch { return {}; }
  }
  function writeSettings(obj) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj || {})); } catch (_) {}
  }
  function writePending(obj) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(obj || {})); } catch (_) {}
  }
  function readPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); }
    catch { return null; }
  }
  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
  }
  function saveSettings(updates, options) {
    const opts = options || {};
    const merged = Object.assign(getSettings(), updates || {});
    merged[TS_FIELD] = Date.now();
    writeSettings(merged);
    // Always stash a pending copy too: if the user isn't authenticated yet
    // (e.g. mid-signup before email confirm) we still want these to land on
    // the server after the first sign-in.
    writePending(stripLargeFields(merged));
    if (opts.flush) {
      return flushPushSettings().then(() => merged);
    }
    schedulePushSettings();
    return merged;
  }
  function clearSettings() {
    localStorage.removeItem(SETTINGS_KEY);
    clearPending();
  }

  // ----- Cross-device sync for LoveFlix.getSettings -----
  // Photos are compressed to thumbnails at upload time (max 200px, JPEG 0.75)
  // so they are small enough to store in D1 and sync across all devices.
  const LARGE_FIELDS = [];
  function stripLargeFields(settings) {
    const out = {};
    for (const k of Object.keys(settings || {})) {
      if (LARGE_FIELDS.includes(k)) continue;
      out[k] = settings[k];
    }
    return out;
  }

  // Promise that resolves on the first completed pull (or its fallback). Pages
  // that need accurate names — profile selectors, settings, anywhere a name is
  // displayed — should `await LoveFlix.ensureSettingsReady()` before painting.
  let _settingsReady;
  let _settingsReadyResolve;
  function resetSettingsReady() {
    _settingsReady = new Promise(r => { _settingsReadyResolve = r; });
  }
  resetSettingsReady();
  function resolveSettingsReady(value) {
    if (_settingsReadyResolve) {
      _settingsReadyResolve(value);
      _settingsReadyResolve = null;
    }
  }
  function ensureSettingsReady() {
    return _settingsReady;
  }

  let _pushTimer = null;
  let _pushInFlight = null;
  function schedulePushSettings() {
    if (!getToken()) return; // unauthenticated → pending mirror only
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => { pushSettings().catch(() => {}); }, 400);
  }
  async function flushPushSettings() {
    clearTimeout(_pushTimer);
    return pushSettings();
  }
  async function pushSettings() {
    if (!getToken()) return; // pending mirror will flush on next sign-in
    await ensureFreshToken();
    if (!getToken()) return; // token invalid even after refresh
    if (_pushInFlight) {
      // Coalesce concurrent pushes; the in-flight one already reads the
      // latest local copy at send time.
      return _pushInFlight;
    }
    _pushInFlight = (async () => {
      try {
        await api('/api/settings', {
          method: 'PUT',
          body: { settings: stripLargeFields(getSettings()) },
        });
        clearPending();
      } catch (e) {
        // Keep pending so the next page load / sign-in retries automatically.
        console.warn('settings sync push failed', e && e.message);
        throw e;
      }
    })();
    try { await _pushInFlight; } finally { _pushInFlight = null; }
  }

  // Push any settings saved while unauthenticated. Called automatically after
  // signIn/signUp and before pullSettings.
  async function flushPendingIfAny() {
    if (!getToken()) return;
    const pending = readPending();
    if (!pending || typeof pending !== 'object') return;
    // Merge pending into local so subsequent reads see them immediately.
    const local = getSettings();
    const merged = Object.assign({}, local, pending);
    // Keep whichever timestamp is newer.
    const ts = Math.max(local[TS_FIELD] || 0, pending[TS_FIELD] || 0, Date.now());
    merged[TS_FIELD] = ts;
    writeSettings(merged);
    try {
      await api('/api/settings', { method: 'PUT', body: { settings: stripLargeFields(merged) } });
      clearPending();
    } catch (e) {
      console.warn('pending settings flush failed', e && e.message);
    }
  }

  // Decide whether a settings object contains anything user-meaningful (i.e.
  // anything beyond the bookkeeping timestamp). Pure-timestamp objects count
  // as empty for sync-direction decisions.
  function hasMeaningfulFields(obj) {
    if (!obj || typeof obj !== 'object') return false;
    for (const k of Object.keys(obj)) {
      if (k === TS_FIELD) continue;
      if (obj[k] !== '' && obj[k] != null) return true;
    }
    return false;
  }

  async function pullSettings() {
    try {
      await flushPendingIfAny();
      const data = await api('/api/settings');
      const serverSettings = (data && data.settings && typeof data.settings === 'object')
        ? data.settings : null;
      const local = getSettings();
      const localTs = local[TS_FIELD] || 0;
      const serverTs = serverSettings && serverSettings[TS_FIELD]
        ? serverSettings[TS_FIELD]
        : ((data && data.updated_at) || 0) * 1000;

      let next;
      const serverHas = hasMeaningfulFields(serverSettings);
      const localHas = hasMeaningfulFields(local);
      if (!serverHas) {
        // Nothing meaningful on the server yet — keep local, and if we're
        // authenticated and have anything worth syncing, force-push it now
        // (and KEEP the pending copy until the server confirms it landed, so
        // future page loads retry on their own).
        next = local;
        if (getToken() && localHas) {
          writePending(stripLargeFields(local));
          flushPushSettings().catch(() => {});
        }
      } else if (localTs && localTs > serverTs && localHas) {
        // Local has unsaved/newer changes (e.g. user edited a name and we
        // got here before the debounced push fired). Keep local and push.
        next = local;
        if (getToken()) flushPushSettings().catch(() => {});
      } else {
        // Server is authoritative. Adopt it but keep local-only fields
        // (photos) that we never push.
        next = Object.assign({}, serverSettings);
        for (const k of LARGE_FIELDS) if (local[k]) next[k] = local[k];
        writeSettings(next);
      }
      resolveSettingsReady(next);
      return next;
    } catch (e) {
      console.warn('settings sync pull failed', e && e.message);
    }
    const fallback = getSettings();
    resolveSettingsReady(fallback);
    return fallback;
  }

  // Active profile derived from the logged-in user's couple_members role
  // (cached by cacheCoupleId). Falls back to 'admin' so admin pages work
  // correctly when the cache hasn't been populated yet.
  function getActiveProfile() {
    const settings = getSettings();
    const adminName = settings.adminName || 'You';
    const partnerName = settings.partnerName || 'My Love';
    const role = (function() { try { return localStorage.getItem('loveflix_role') || 'admin'; } catch (_) { return 'admin'; } })();
    const isPartner = role === 'partner';
    return {
      role: isPartner ? 'her' : 'his',
      dbRole: role,
      name: isPartner ? partnerName : adminName,
      photo: isPartner ? (settings.partnerPhoto || '') : (settings.adminPhoto || ''),
      initial: ((isPartner ? partnerName : adminName)[0] || '?').toUpperCase(),
    };
  }

  // Paint the top-right viewer avatar (home/browse) with the active profile.
  // Re-paints automatically once settings finish syncing from the server.
  function paintNavAvatar(el) {
    if (!el) return;
    const apply = () => {
      const p = getActiveProfile();
      el.textContent = p.initial;
      if (p.photo) {
        el.style.background = `url(${JSON.stringify(p.photo)}) center/cover no-repeat`;
        el.style.color = 'transparent';
      } else {
        el.style.background = '';
        el.style.color = '';
      }
    };
    apply();
    ensureSettingsReady().then(apply).catch(() => {});
  }

  async function signIn(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign-in failed');
    setSession(data);
    // Pull/merge settings before redirecting so the next page sees real names.
    resetSettingsReady();
    try { await pullSettings(); } catch (_) {}
    cacheCoupleId().catch(() => {});
    return data;
  }

  async function signUp(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign-up failed');
    if (data.access_token) {
      setSession(data);
      // Flush anything entered before signup completed.
      try { await flushPendingIfAny(); } catch (_) {}
      cacheCoupleId().catch(() => {});
    }
    return data;
  }

  function signOut() {
    clearSession();
    location.href = 'loveflix_login_screen.html';
  }

  // Block protected pages until a token exists.
  function requireAuth() {
    if (!getToken()) {
      location.replace('loveflix_login_screen.html');
      return false;
    }
    return true;
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const token = getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    // Forward the couple creator's id so the worker resolves the right tenant
    // when the logged-in user is the partner rather than the admin/creator.
    const creatorId = getCreatorId();
    if (creatorId) headers['x-tenant-id'] = creatorId;
    if (opts.body && !(opts.body instanceof FormData) && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)
        ? JSON.stringify(opts.body)
        : opts.body,
    });

    if (res.status === 401) {
      clearSession();
      location.replace('loveflix_login_screen.html');
      throw new Error('unauthorized');
    }

    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  // Direct PUT to R2 with progress.
  function putWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);
      const token = getToken();
      if (token && new URL(url, location.href).origin === location.origin) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && typeof onProgress === 'function') {
          onProgress(e.loaded / e.total, e.loaded, e.total);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`));
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => reject(new Error('Upload aborted'));
      xhr.send(file);
    });
  }

  // Kick off a settings refresh on every page load. Pages that need to wait
  // for it can `await LoveFlix.ensureSettingsReady()`. We only pull when
  // authenticated; an anonymous pull would hit the public /api/settings
  // endpoint with the default tenant and could race-resolve the ready
  // promise with empty data, masking the real server response from the
  // post-signin pull.
  if (typeof document !== 'undefined') {
    const run = () => {
      if (getToken()) {
        pullSettings().catch(() => {});
      } else {
        // Resolve ready immediately with whatever's local so anonymous pages
        // (login screen, landing) don't hang waiting on a pull we won't make.
        resolveSettingsReady(getSettings());
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else { run(); }
    window.addEventListener('focus', () => { if (getToken()) pullSettings().catch(() => {}); });
    // Cross-tab updates: if another tab changes settings, mirror in this tab.
    window.addEventListener('storage', e => {
      if (e.key === SETTINGS_KEY) {
        // Storage event already wrote the new value; just notify listeners.
        try { window.dispatchEvent(new Event('loveflix:settings-changed')); } catch (_) {}
      }
    });
  }

  function parseJwtUserId(token) {
    try {
      return JSON.parse(atob(token.split('.')[1])).sub;
    } catch { return null; }
  }

  function getUserId() {
    const u = getUser();
    if (u && u.id) return u.id;
    const token = getToken();
    return token ? parseJwtUserId(token) : null;
  }

  function getCoupleId() {
    try { return localStorage.getItem('loveflix_couple_id') || null; }
    catch { return null; }
  }

  function getCreatorId() {
    try { return localStorage.getItem('loveflix_creator_id') || null; }
    catch { return null; }
  }

  // After sign-in, look up the couple row for this user and cache its id +
  // billing-owner flag. Best-effort: failures are silent (the worker also
  // derives couple_id from the user on the server side).
  async function cacheCoupleId() {
    const userId = getUserId();
    const token = getToken();
    if (!userId || !token) return;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${userId}&select=couple_id,is_billing_owner,role&limit=1`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
          },
        }
      );
      if (!res.ok) return;
      const rows = await res.json();
      const row = rows && rows[0];
      if (!row) return;
      if (row.couple_id) localStorage.setItem('loveflix_couple_id', row.couple_id);
      if (row.role) localStorage.setItem('loveflix_role', row.role);
      if (typeof row.is_billing_owner === 'boolean') {
        localStorage.setItem('loveflix_is_billing_owner', row.is_billing_owner ? '1' : '0');
      }
      // Cache the creator's (admin's) user_id so every API call targets the
      // shared couple tenant regardless of which partner is signed in.
      if (row.role === 'admin') {
        localStorage.setItem('loveflix_creator_id', userId);
      } else if (row.couple_id) {
        try {
          const r2 = await fetch(
            `${SUPABASE_URL}/rest/v1/couple_members?couple_id=eq.${row.couple_id}&role=eq.admin&select=user_id&limit=1`,
            { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
          );
          if (r2.ok) {
            const admins = await r2.json();
            const admin = admins && admins[0];
            if (admin && admin.user_id) localStorage.setItem('loveflix_creator_id', admin.user_id);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  function isBillingOwnerCached() {
    return localStorage.getItem('loveflix_is_billing_owner') === '1';
  }

  // Authoritative check — pings Supabase and refreshes the cache. Use this on
  // billing pages before enabling any subscription-mutating UI.
  async function fetchIsBillingOwner() {
    const userId = getUserId();
    const token = getToken();
    if (!userId || !token) return false;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${userId}&select=is_billing_owner&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return isBillingOwnerCached();
      const rows = await res.json();
      const flag = !!(rows && rows[0] && rows[0].is_billing_owner);
      localStorage.setItem('loveflix_is_billing_owner', flag ? '1' : '0');
      return flag;
    } catch { return isBillingOwnerCached(); }
  }

  // Fetch both members of the current user's couple. Returns
  // [{ user_id, display_name, role, is_billing_owner }, ...] (1 or 2 rows).
  async function fetchCoupleMembers() {
    const token = getToken();
    const coupleId = getCoupleId();
    if (!token || !coupleId) return [];
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?couple_id=eq.${coupleId}&select=user_id,display_name,role,is_billing_owner`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return [];
      const rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  async function getUserRole() {
    const userId = getUserId();
    const token = getToken();
    if (!userId || !token) return null;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/couple_members?user_id=eq.${userId}&select=role&limit=1`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
          },
        }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      return (rows && rows[0] && rows[0].role) || null;
    } catch { return null; }
  }

  global.LoveFlix = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    getToken,
    refreshSession,
    ensureFreshToken,
    getUserId,
    getCoupleId,
    getCreatorId,
    cacheCoupleId,
    getUserRole,
    isBillingOwnerCached,
    fetchIsBillingOwner,
    fetchCoupleMembers,
    getUser,
    setSession,
    clearSession,
    getSettings,
    saveSettings,
    clearSettings,
    pullSettings,
    pushSettings,
    flushPushSettings,
    ensureSettingsReady,
    signIn,
    signUp,
    signOut,
    requireAuth,
    api,
    putWithProgress,
    getActiveProfile,
    paintNavAvatar,
  };
})(window);
