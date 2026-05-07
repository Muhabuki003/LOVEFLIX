// LoveFlix shared client — Supabase auth + API helpers.
// Used by every page. Vanilla JS, no build step.
(function (global) {
  const SUPABASE_URL = 'https://jeblgjjutyzzdursjqnn.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplYmxnamp1dHl6emR1cnNqcW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMzY0NjgsImV4cCI6MjA5MzcxMjQ2OH0.X9YVrfLJ4JSIBdXVkpYegeZ5kEqJzkmzQ1P0d3tFoko';

  const TOKEN_KEY = 'loveflix_token';
  const USER_KEY = 'loveflix_user';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }
  function setSession({ access_token, user }) {
    if (access_token) localStorage.setItem(TOKEN_KEY, access_token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
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
    if (data.access_token) setSession(data);
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

  global.LoveFlix = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    getToken,
    getUser,
    setSession,
    clearSession,
    signIn,
    signUp,
    signOut,
    requireAuth,
    api,
    putWithProgress,
  };
})(window);
