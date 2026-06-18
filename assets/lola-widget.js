// ─────────────────────────────────────────────────────────────────────────────
// Lola — LOVEFLIX AI relationship concierge.
//
// A self-contained floating widget that can be dropped onto any signed-in page.
// It renders a draggable / resizable launcher + chat panel and talks to the
// existing /api/ai endpoint in "concierge" mode (DeepSeek, keyed by the
// DEEPSEEK_API_KEY Cloudflare secret). No build step, no dependencies.
//
// Public API (window.Lola):
//   Lola.open()    — open the chat panel
//   Lola.close()   — close it
//   Lola.toggle()  — toggle
//
// Configuration (set window.LOLA_CONFIG before this script loads):
//   { noLauncher: true }  — hide the floating launcher (used on pages that open
//                           Lola from a nav button / grid box instead, e.g. home)
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // Guard against double-injection (nav.js + per-page tags both load us).
  if (window.__lolaLoaded) return;
  window.__lolaLoaded = true;

  var CFG = window.LOLA_CONFIG || {};
  var API_AI    = '/api/ai';
  var API_STATS = '/api/couple-stats';
  var LOGO      = '/assets/lola-logo.png';
  var LS_POS    = 'lola_launcher_pos';
  var LS_SIZE   = 'lola_panel_size';

  // ── Only show Lola to signed-in couples ────────────────────────────────────
  function isSignedIn() {
    try {
      if (localStorage.getItem('loveflix_token')) return true;
      var s = JSON.parse(localStorage.getItem('loveflix_settings') || '{}');
      return !!(s && (s.adminName || s.partnerName || s.partner_1_name));
    } catch (e) { return false; }
  }
  if (!isSignedIn()) return;

  var isMobile = window.matchMedia('(max-width: 600px)').matches;

  // ── Styles ─────────────────────────────────────────────────────────────────
  if (!document.getElementById('lola-style')) {
    var st = document.createElement('style');
    st.id = 'lola-style';
    st.textContent = [
      '.lola-root{--lo-red:#e50914;--lo-rose:#ff5f8f;--lo-panel:rgba(18,18,18,0.94);--lo-border:rgba(255,255,255,0.09);--lo-border-s:rgba(255,255,255,0.16);--lo-text:#f4f4f4;--lo-dim:#8a8a8a;--lo-light:#cfcfcf;--lo-green:#10b981;--lo-launch:60px;--lo-gap:24px;font-family:"Inter",system-ui,sans-serif}',
      // panel
      '.lola-panel{position:fixed;right:var(--lo-gap);bottom:calc(var(--lo-gap) + var(--lo-launch) + 14px);width:380px;height:560px;max-height:calc(100vh - 2*var(--lo-gap));max-width:calc(100vw - 2*var(--lo-gap));z-index:2147483000;display:flex;flex-direction:column;background:var(--lo-panel);-webkit-backdrop-filter:blur(26px) saturate(1.2);backdrop-filter:blur(26px) saturate(1.2);border:1px solid var(--lo-border);border-radius:22px;box-shadow:0 30px 80px -20px rgba(0,0,0,0.8),0 0 0 1px rgba(0,0,0,0.4);overflow:hidden;opacity:0;transform:translateY(12px) scale(.96);transform-origin:bottom right;pointer-events:none;transition:transform .34s cubic-bezier(.2,.9,.25,1),opacity .24s ease}',
      '.lola-panel.lola-open{opacity:1;transform:none;pointer-events:auto}',
      // header
      '.lola-head{display:flex;align-items:center;gap:12px;padding:16px 14px;border-bottom:1px solid var(--lo-border);background:linear-gradient(180deg,rgba(229,9,20,0.10),transparent);flex-shrink:0;cursor:grab;touch-action:none}',
      '.lola-head:active{cursor:grabbing}',
      '.lola-badge{width:40px;height:40px;border-radius:50%;flex-shrink:0;position:relative;background:radial-gradient(circle at 32% 28%,#ffb3c7 0%,transparent 55%),linear-gradient(135deg,var(--lo-rose) 0%,var(--lo-red) 78%);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(229,9,20,0.4)}',
      '.lola-badge .lo-heart{color:#fff;font-size:18px;line-height:1}',
      '.lola-badge .lo-dot{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:var(--lo-green);border:2px solid #141414;box-shadow:0 0 8px var(--lo-green)}',
      '.lola-id{flex:1;min-width:0;line-height:1.1}',
      '.lola-id .lo-nm{font-family:"Bebas Neue",sans-serif;font-size:22px;letter-spacing:1.5px;display:flex;align-items:center;gap:8px;color:#fff}',
      '.lola-id .lo-tag{font-size:8.5px;font-weight:800;letter-spacing:1.5px;color:var(--lo-red);border:1px solid rgba(229,9,20,0.55);padding:2px 5px;border-radius:4px}',
      '.lola-id .lo-st{font-size:11px;color:var(--lo-dim);margin-top:3px;display:flex;align-items:center;gap:6px}',
      '.lola-id .lo-st b{color:var(--lo-green);font-weight:600}',
      '.lola-close{width:32px;height:32px;border-radius:9px;flex-shrink:0;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid var(--lo-border);display:flex;align-items:center;justify-content:center;color:var(--lo-light);transition:background .15s,border-color .15s,transform .1s}',
      '.lola-close:hover{background:var(--lo-red);border-color:var(--lo-red);color:#fff}',
      '.lola-close:active{transform:scale(.92)}',
      '.lola-close svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none}',
      // body
      '.lola-body{flex:1;overflow-y:auto;padding:20px 16px 8px;display:flex;flex-direction:column;gap:14px}',
      '.lola-body::-webkit-scrollbar{width:6px}',
      '.lola-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:3px}',
      '.lola-day{align-self:center;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--lo-dim);background:rgba(255,255,255,0.04);padding:4px 10px;border-radius:999px}',
      '.lola-msg{max-width:82%;display:flex;flex-direction:column;gap:4px;animation:lolaRise .4s cubic-bezier(.2,.8,.2,1) both}',
      '@keyframes lolaRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '.lola-msg .lo-bubble{padding:11px 14px;font-size:13.5px;line-height:1.5;border-radius:16px;word-wrap:break-word;overflow-wrap:anywhere}',
      '.lola-msg .lo-meta{font-size:10px;color:var(--lo-dim);padding:0 6px}',
      '.lola-msg.bot{align-self:flex-start}',
      '.lola-msg.bot .lo-bubble{background:rgba(255,255,255,0.06);border:1px solid var(--lo-border);border-bottom-left-radius:5px;color:var(--lo-light)}',
      '.lola-msg.me{align-self:flex-end;align-items:flex-end}',
      '.lola-msg.me .lo-bubble{background:linear-gradient(135deg,var(--lo-rose),var(--lo-red));color:#fff;border-bottom-right-radius:5px;font-weight:500}',
      '.lola-chips{display:flex;flex-wrap:wrap;gap:8px;padding:2px 2px 8px;animation:lolaRise .45s .1s both}',
      '.lola-chip{font-size:12px;font-weight:500;color:var(--lo-light);cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid var(--lo-border-s);padding:8px 13px;border-radius:999px;transition:all .15s;display:inline-flex;align-items:center;gap:6px}',
      '.lola-chip:hover{background:rgba(229,9,20,0.16);border-color:rgba(229,9,20,0.5);color:#fff;transform:translateY(-1px)}',
      '.lola-chip .lo-ic{color:var(--lo-rose)}',
      '.lola-typing{align-self:flex-start;display:none;gap:4px;padding:13px 16px;background:rgba(255,255,255,0.06);border:1px solid var(--lo-border);border-radius:16px;border-bottom-left-radius:5px}',
      '.lola-typing.on{display:flex}',
      '.lola-typing i{width:6px;height:6px;border-radius:50%;background:var(--lo-dim);animation:lolaBlink 1.3s infinite}',
      '.lola-typing i:nth-child(2){animation-delay:.18s}.lola-typing i:nth-child(3){animation-delay:.36s}',
      '@keyframes lolaBlink{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',
      // input
      '.lola-input{flex-shrink:0;display:flex;align-items:center;gap:10px;padding:12px 14px;border-top:1px solid var(--lo-border);background:rgba(0,0,0,0.25)}',
      '.lola-field{flex:1;min-width:0;display:flex;align-items:center;background:rgba(255,255,255,0.06);border:1px solid var(--lo-border);border-radius:999px;padding:0 6px 0 16px;transition:border-color .15s}',
      '.lola-field:focus-within{border-color:rgba(229,9,20,0.55)}',
      '.lola-field input{flex:1;background:none;border:none;outline:none;color:var(--lo-text);font-family:inherit;font-size:13px;padding:11px 0}',
      '.lola-field input::placeholder{color:var(--lo-dim)}',
      '.lola-send{width:34px;height:34px;border-radius:50%;flex-shrink:0;cursor:pointer;border:none;background:linear-gradient(135deg,var(--lo-rose),var(--lo-red));display:flex;align-items:center;justify-content:center;color:#fff;transition:transform .12s,filter .15s;box-shadow:0 4px 14px rgba(229,9,20,0.4)}',
      '.lola-send:hover{filter:brightness(1.08)}.lola-send:active{transform:scale(.9)}',
      '.lola-send svg{width:15px;height:15px;fill:#fff}',
      // resize handle
      '.lola-resize{position:absolute;left:0;top:0;width:18px;height:18px;cursor:nwse-resize;z-index:5}',
      '.lola-resize::before{content:"";position:absolute;left:6px;top:6px;width:7px;height:7px;border-left:2px solid rgba(255,255,255,0.3);border-top:2px solid rgba(255,255,255,0.3);border-radius:2px 0 0 0}',
      // floating launcher
      '.lola-logo{position:fixed;right:var(--lo-gap);bottom:var(--lo-gap);width:var(--lo-launch);height:var(--lo-launch);z-index:2147483001;cursor:pointer;touch-action:none}',
      '.lola-bob{width:100%;height:100%;animation:lolaBob 4.5s ease-in-out infinite}',
      '.lola-logo.lola-dragging .lola-bob,.lola-logo.lola-active .lola-bob{animation:none}',
      '@keyframes lolaBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
      '.lola-logo img{width:100%;height:100%;object-fit:contain;display:block;-webkit-user-drag:none;user-select:none;pointer-events:none;animation:lolaGlow 2.8s ease-in-out infinite}',
      '@keyframes lolaGlow{0%,100%{filter:drop-shadow(0 6px 12px rgba(0,0,0,.55)) drop-shadow(0 0 7px rgba(229,9,20,.35))}50%{filter:drop-shadow(0 6px 12px rgba(0,0,0,.55)) drop-shadow(0 0 18px rgba(229,9,20,.75))}}',
      '.lola-tip{position:fixed;z-index:2147483001;background:#141414;border:1px solid var(--lo-border);color:var(--lo-light);font-size:12.5px;font-weight:500;white-space:nowrap;padding:9px 14px;border-radius:11px;box-shadow:0 10px 30px rgba(0,0,0,0.5);opacity:0;pointer-events:none;transition:opacity .2s}',
      '.lola-tip b{color:#fff}',
      // action cards
      '.lola-actions{display:flex;flex-direction:column;gap:10px;align-self:flex-start;width:100%;animation:lolaRise .4s both}',
      '.lola-card{background:rgba(255,255,255,0.05);border:1px solid var(--lo-border-s);border-radius:14px;padding:12px 13px}',
      '.lola-card .lo-cat{font-size:9.5px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:var(--lo-rose)}',
      '.lola-card .lo-name{font-size:14px;font-weight:600;color:#fff;margin-top:3px}',
      '.lola-card .lo-reason{font-size:12px;color:var(--lo-light);margin-top:4px;line-height:1.4}',
      '.lola-card .lo-addr{font-size:11px;color:var(--lo-dim);margin-top:4px}',
      '.lola-card .lo-tracks{margin:8px 0 0;padding-left:16px;font-size:12px;color:var(--lo-light);line-height:1.6}',
      '.lola-card .lo-tracks span{color:var(--lo-dim)}',
      '.lola-go{margin-top:10px;width:100%;cursor:pointer;border:none;border-radius:10px;padding:9px;font-family:inherit;font-size:12.5px;font-weight:600;color:#fff;background:linear-gradient(135deg,var(--lo-rose),var(--lo-red));transition:filter .15s,transform .1s}',
      '.lola-go:hover{filter:brightness(1.08)}.lola-go:active{transform:scale(.97)}',
      '.lola-go:disabled{opacity:.7;cursor:default}',
      // date-spot two-pane result
      '.lola-spots{display:grid;grid-template-columns:40% 1fr;gap:10px;align-self:stretch;width:100%;animation:lolaRise .4s both}',
      '.lola-spots-list{display:flex;flex-direction:column;gap:10px;max-height:430px;overflow-y:auto;padding-right:2px}',
      '.lola-spots-list::-webkit-scrollbar{width:5px}.lola-spots-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}',
      '.lola-spot-card{display:flex;flex-direction:column;gap:6px;cursor:pointer;text-align:left;padding:0;border:1px solid transparent;border-radius:13px;background:none;transition:border-color .15s}',
      '.lola-spot-card .lo-thumb{width:100%;height:92px;border-radius:11px;background-size:cover;background-position:center;background-color:#2a2120;display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.lola-spot-card .lo-thumb span{font-family:"Bebas Neue",sans-serif;font-size:34px;color:rgba(255,255,255,.5)}',
      '.lola-spot-card.on .lo-thumb{outline:2px solid var(--lo-red);outline-offset:1px}',
      '.lola-spot-card .lo-sc-cat{font-size:8px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--lo-rose);opacity:.85}',
      '.lola-spot-card .lo-sc-name{font-family:"Bebas Neue",sans-serif;font-size:16px;letter-spacing:.6px;color:#fff;line-height:1.05}',
      '.lola-spot-card .lo-rate{font-family:"Inter",sans-serif;font-size:11px;color:var(--lo-dim);letter-spacing:0}',
      '.lo-stars{display:block;font-size:11px;color:#f5b301;letter-spacing:1px}',
      '.lola-spots-feature{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.lola-spots-feature .lo-hero{position:relative;width:100%;min-height:190px;flex:1;border-radius:14px;background-size:cover;background-position:center;background-color:#241a18;display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.lola-spots-feature .lo-hero-ph{font-family:"Bebas Neue",sans-serif;font-size:64px;color:rgba(255,255,255,.4)}',
      '.lo-view{position:absolute;left:12px;right:12px;bottom:12px;cursor:pointer;border:none;border-radius:11px;padding:11px;font-family:"Bebas Neue",sans-serif;font-size:16px;letter-spacing:2px;color:#fff;background:linear-gradient(135deg,rgba(255,95,143,.92),rgba(229,9,20,.92));-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);transition:filter .15s,transform .1s}',
      '.lo-view:hover{filter:brightness(1.08)}.lo-view:active{transform:scale(.98)}',
      '.lola-spots-feature .lo-pick{background:rgba(255,255,255,.05);border:1px solid var(--lo-border-s);border-radius:14px;padding:13px}',
      '.lo-pick-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}',
      '.lo-pick-label{font-size:9px;font-weight:800;letter-spacing:1.4px;color:var(--lo-red)}',
      '.lo-pick-name{font-family:"Bebas Neue",sans-serif;font-size:21px;letter-spacing:.8px;color:#fff;line-height:1.02}',
      '.lo-pick-addr{font-size:9.5px;line-height:1.35;color:var(--lo-light);text-align:right;max-width:42%;text-transform:uppercase;letter-spacing:.5px}',
      '.lo-pick .lo-stars{margin:7px 0 6px}',
      '.lo-pick-desc{font-size:12px;line-height:1.5;color:var(--lo-light)}',
      '@media(max-width:600px){.lola-spots{grid-template-columns:1fr}.lola-spots-list{flex-direction:row;max-height:none;overflow-x:auto}.lola-spot-card{min-width:120px}}',
      // mobile
      '@media(max-width:600px){.lola-root{--lo-gap:12px}.lola-panel{right:0;left:0;bottom:0;top:auto;width:100vw;height:78vh;max-height:none;max-width:none;border-radius:22px 22px 0 0;transform-origin:bottom center}.lola-logo{top:14px;right:14px;bottom:auto;width:52px;height:52px}.lola-resize{display:none}.lola-head{cursor:default}.lola-tip{display:none}}',
    ].join('');
    document.head.appendChild(st);
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  var root = document.createElement('div');
  root.className = 'lola-root';
  root.innerHTML =
    '<section class="lola-panel" id="lolaPanel" aria-label="Chat with Lola">' +
      '<div class="lola-resize" id="lolaResize" aria-hidden="true"></div>' +
      '<header class="lola-head" id="lolaHead">' +
        '<div class="lola-badge"><span class="lo-heart">♥</span><span class="lo-dot"></span></div>' +
        '<div class="lola-id"><div class="lo-nm">LOLA <span class="lo-tag">AI</span></div>' +
        '<div class="lo-st"><b>Online</b> · your LOVEFLIX concierge</div></div>' +
        '<button class="lola-close" id="lolaClose" aria-label="Close chat"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>' +
      '</header>' +
      '<div class="lola-body" id="lolaBody">' +
        '<div class="lola-day">Today</div>' +
        '<div class="lola-typing" id="lolaTyping" aria-hidden="true"><i></i><i></i><i></i></div>' +
      '</div>' +
      '<div class="lola-input">' +
        '<label class="lola-field"><input id="lolaField" type="text" placeholder="Message Lola…" autocomplete="off"></label>' +
        '<button class="lola-send" id="lolaSend" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M3 11l18-8-8 18-2-7-8-3z"></path></svg></button>' +
      '</div>' +
    '</section>' +
    (CFG.noLauncher ? '' :
      '<div class="lola-logo" id="lolaLogo" role="button" tabindex="0" aria-label="Open Lola chat"><div class="lola-bob"><img src="' + LOGO + '" alt="Lola"></div></div>' +
      '<div class="lola-tip" id="lolaTip">Chat with <b>Lola</b> ♥</div>');
  document.body.appendChild(root);

  var panel  = document.getElementById('lolaPanel');
  var bodyEl = document.getElementById('lolaBody');
  var typing = document.getElementById('lolaTyping');
  var field  = document.getElementById('lolaField');
  var logo   = document.getElementById('lolaLogo');
  var tip    = document.getElementById('lolaTip');
  var isOpen = false;
  var greeted = false;

  // ── Couple context (mirrors the legacy concierge widget) ───────────────────
  var coupleCtx = {};
  var ctxReady = false;
  var history = [];

  function loadCoupleContext() {
    var token = localStorage.getItem('loveflix_token');
    var settings;
    try {
      settings = (window.LoveFlix && LoveFlix.getSettings) ? LoveFlix.getSettings()
        : JSON.parse(localStorage.getItem('loveflix_settings') || '{}');
    } catch (e) { settings = {}; }

    var name1 = settings.adminName   || settings.partner_1_name || 'Partner 1';
    var name2 = settings.partnerName || settings.partner_2_name || 'Partner 2';

    coupleCtx = {
      coupleName: name1 + ' & ' + name2,
      name1: name1, name2: name2,
      daysTogether: 'unknown', totalVideos: '?',
      lastVideoUploaded: 'recently', musicGenres: 'your shared music',
      city: settings.city || 'your city', nextFreeDay: 'soon',
      recentDates: 'recent adventures', avgBudgetSpent: 'your usual range',
      daysSinceLastUpload: null,
    };

    if (token) {
      fetch(API_STATS, { headers: { Authorization: 'Bearer ' + token } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          if (d.daysTogether != null) coupleCtx.daysTogether = d.daysTogether;
          if (d.totalVideos != null) coupleCtx.totalVideos = d.totalVideos;
          if (d.daysSinceLastUpload != null) coupleCtx.daysSinceLastUpload = d.daysSinceLastUpload;
          if (d.partner1Name) coupleCtx.name1 = d.partner1Name;
          if (d.partner2Name) coupleCtx.name2 = d.partner2Name;
          if (d.partner1Name || d.partner2Name) coupleCtx.coupleName = coupleCtx.name1 + ' & ' + coupleCtx.name2;
          if (d.lastUploadedAt) {
            var dt = new Date(d.lastUploadedAt);
            coupleCtx.lastVideoUploaded = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
          }
        })
        .catch(function () {})
        .then(function () { ctxReady = true; });
    } else {
      ctxReady = true;
    }
  }
  loadCoupleContext();
  loadLocations();
  window.addEventListener('storage', function (e) {
    if (e.key === 'loveflix_settings') loadCoupleContext();
  });

  // ── Both partners' locations + timezones (for halfway date ideas) ──────────
  // Decode PostGIS WKB point hex → [lng, lat] (same routine the home orbit uses).
  function parseWKB(hex) {
    if (!hex || hex.length < 42) return null;
    try {
      var buf = new Uint8Array(hex.match(/../g).map(function (b) { return parseInt(b, 16); }));
      var view = new DataView(buf.buffer);
      var le = buf[0] === 1;
      var type = view.getUint32(1, le);
      var off = (type & 0x20000000) ? 9 : 5;
      var lng = view.getFloat64(off, le);
      var lat = view.getFloat64(off + 8, le);
      return (isFinite(lng) && isFinite(lat)) ? [lng, lat] : null;
    } catch (e) { return null; }
  }
  // Rough timezone from longitude (15° ≈ 1h). Good enough for "they're ~Nh ahead".
  function approxTz(lng) {
    if (lng == null || !isFinite(lng)) return null;
    var off = Math.round(lng / 15);
    return 'UTC' + (off >= 0 ? '+' + off : off);
  }

  function loadLocations() {
    if (!window.LoveFlix || !LoveFlix.getToken) return;
    var token = LoveFlix.getToken && LoveFlix.getToken();
    var coupleId = LoveFlix.getCoupleId && LoveFlix.getCoupleId();
    var userId = LoveFlix.getUserId && LoveFlix.getUserId();
    if (!token || !coupleId || !userId) return;

    // The current user's real IANA timezone, straight from the browser.
    try { coupleCtx.yourTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}

    fetch(LoveFlix.SUPABASE_URL + '/rest/v1/couple_locations?couple_id=eq.' +
      encodeURIComponent(coupleId) + '&select=user_id,location,city,updated_at&order=updated_at.desc', {
      headers: { Authorization: 'Bearer ' + token, apikey: LoveFlix.SUPABASE_ANON_KEY },
    })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        if (!Array.isArray(rows)) return;
        var you = null, partner = null;
        rows.forEach(function (row) {
          if (row.user_id === userId && !you) you = row;
          else if (row.user_id !== userId && !partner) partner = row;
        });
        function pack(row) {
          if (!row) return null;
          var c = parseWKB(row.location);
          return {
            city: row.city || (c ? c[1].toFixed(2) + '°, ' + c[0].toFixed(2) + '°' : 'unknown'),
            coords: c,
            approxTimezone: c ? approxTz(c[0]) : null,
          };
        }
        var y = pack(you), p = pack(partner);
        if (y) {
          coupleCtx.yourLocation = y.city;
          if (!coupleCtx.yourTimezone && y.approxTimezone) coupleCtx.yourTimezone = y.approxTimezone + ' (approx)';
        }
        if (p) {
          coupleCtx.partnerLocation = p.city;
          coupleCtx.partnerTimezone = p.approxTimezone ? p.approxTimezone + ' (approx)' : null;
        }
        // Geographic midpoint → anchor for "meet halfway" date spots.
        if (y && p && y.coords && p.coords) {
          var mlng = (y.coords[0] + p.coords[0]) / 2;
          var mlat = (y.coords[1] + p.coords[1]) / 2;
          coupleCtx.midpoint = mlat.toFixed(3) + '°, ' + mlng.toFixed(3) + '°';
          // crude great-circle-ish distance (km) so Lola knows if they're near or far
          var dx = (p.coords[0] - y.coords[0]) * 111 * Math.cos(mlat * Math.PI / 180);
          var dy = (p.coords[1] - y.coords[1]) * 111;
          coupleCtx.distanceApartKm = Math.round(Math.sqrt(dx * dx + dy * dy));
          coupleCtx.sameCity = coupleCtx.distanceApartKm < 30;
        }
      })
      .catch(function () {});
  }

  // ── Messages ────────────────────────────────────────────────────────────
  function addMsg(html, who) {
    var m = document.createElement('div');
    m.className = 'lola-msg ' + who;
    m.innerHTML = '<div class="lo-bubble">' + html + '</div><div class="lo-meta">' +
      (who === 'bot' ? 'Lola' : 'You') + ' · now</div>';
    bodyEl.insertBefore(m, typing);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return m.querySelector('.lo-bubble');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  function greet() {
    if (greeted) return;
    greeted = true;
    var name = coupleCtx.name1 && coupleCtx.name1 !== 'Partner 1' ? (' ' + coupleCtx.name1) : '';
    addMsg("Hey" + escapeHtml(name) + ", I’m Lola ♥ your LOVEFLIX relationship concierge. Tell me what you two are in the mood for and I’ll take care of the rest.", 'bot');
    var chips = document.createElement('div');
    chips.className = 'lola-chips';
    var opts = [
      ['♥', 'Plan a date night', 'Plan a special date night for us this week.'],
      ['☀', 'Surprise me', 'Surprise me with something romantic for us to do.'],
      ['✨', 'Our next adventure', 'What should our next adventure together be?'],
    ];
    opts.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'lola-chip';
      b.innerHTML = '<span class="lo-ic">' + o[0] + '</span> ' + o[1];
      b.addEventListener('click', function () { chips.remove(); send(o[2]); });
      chips.appendChild(b);
    });
    bodyEl.insertBefore(chips, typing);
  }

  function send(text) {
    text = (text || '').trim();
    if (!text) return;
    addMsg(escapeHtml(text), 'me');
    history.push({ role: 'user', content: text });
    field.value = '';
    typing.classList.add('on');
    bodyEl.scrollTop = bodyEl.scrollHeight;

    var token = localStorage.getItem('loveflix_token');
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    fetch(API_AI, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ mode: 'concierge', coupleContext: coupleCtx, messages: history }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.classList.remove('on');
        var reply = (data && data.choices && data.choices[0] && data.choices[0].message &&
          data.choices[0].message.content) || 'Something went wrong — try again!';
        history.push({ role: 'assistant', content: reply });
        if (history.length > 16) history = history.slice(-16);
        var bubble = addMsg('', 'bot');
        var actions = (data && data.lola && Array.isArray(data.lola.actions)) ? data.lola.actions : [];
        typeWriter(escapeHtml(reply), bubble, function () { renderActions(actions); });
      })
      .catch(function () {
        typing.classList.remove('on');
        addMsg('Connection issue — try again in a moment.', 'bot');
      });
  }

  function typeWriter(text, el, done) {
    var i = 0;
    el.textContent = '';
    var iv = setInterval(function () {
      el.textContent += text[i++];
      bodyEl.scrollTop = bodyEl.scrollHeight;
      if (i >= text.length) { clearInterval(iv); if (typeof done === 'function') done(); }
    }, 14);
  }

  // ── Action cards (Lola Knowledge Layer §4) ────────────────────────────────
  // Renders the structured actions Lola returns: date spots (each with a
  // "Go to Spot" button), a flights menu, and a playlist draft.
  function renderActions(actions) {
    if (!actions || !actions.length) return;
    actions.forEach(function (a) {
      if (!a || !a.type) return;
      if (a.type === 'suggest_date_spots') renderDateSpots(a.payload);
      else if (a.type === 'open_flights') renderFlights(a.payload);
      else if (a.type === 'create_playlist_draft') renderPlaylistDraft(a.payload);
    });
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  var CAT_LABEL = {
    near_partner_a: 'Near you',
    near_partner_b: 'Near your partner',
    midpoint: 'Halfway',
  };

  // Render 0-5 stars from a numeric rating (e.g. 4.6 → ★★★★½).
  function starsHtml(rating) {
    var r = Math.max(0, Math.min(5, Number(rating) || 0));
    var full = Math.floor(r), half = (r - full) >= 0.5;
    var s = '';
    for (var i = 0; i < full; i++) s += '★';
    if (half && full < 5) { s += '★'; full++; } // round half up visually
    for (var j = full; j < 5; j++) s += '☆';
    return '<span class="lo-stars">' + s + '</span>';
  }

  function spotInitial(name) {
    return escapeHtml((name || '?').trim().charAt(0).toUpperCase() || '?');
  }

  // Two-pane date-spot result (matches the LOLA in-chat design): a scrollable
  // list of spots on the left, a large hero + "LOLA'S PICK" detail on the right.
  function renderDateSpots(payload) {
    var spots = (payload && Array.isArray(payload.spots)) ? payload.spots : [];
    spots = spots.filter(function (s) { return s && s.name; });
    if (!spots.length) return;

    var wrap = document.createElement('div');
    wrap.className = 'lola-spots';

    var list = document.createElement('div');
    list.className = 'lola-spots-list';

    var feature = document.createElement('div');
    feature.className = 'lola-spots-feature';

    // Background image (or a gradient placeholder with the venue initial).
    function bgFor(s) {
      return s.image
        ? 'background-image:url(\'' + String(s.image).replace(/'/g, '') + '\');'
        : '';
    }

    spots.forEach(function (s, i) {
      var card = document.createElement('button');
      card.className = 'lola-spot-card';
      card.setAttribute('data-i', i);
      card.innerHTML =
        '<div class="lo-thumb" style="' + bgFor(s) + '">' +
          (s.image ? '' : '<span>' + spotInitial(s.name) + '</span>') +
        '</div>' +
        '<div class="lo-sc-meta">' +
          '<div class="lo-sc-cat">' + escapeHtml(CAT_LABEL[s.category] || s.category || '') + '</div>' +
          '<div class="lo-sc-name">' + escapeHtml(s.name) +
            (s.rating ? ' <span class="lo-rate">(' + escapeHtml(String(s.rating)) + ')</span>' : '') +
          '</div>' +
          (s.rating ? starsHtml(s.rating) : '') +
        '</div>';
      card.addEventListener('click', function () {
        Array.prototype.forEach.call(list.children, function (c) { c.classList.remove('on'); });
        card.classList.add('on');
        selectSpot(feature, s);
      });
      list.appendChild(card);
    });

    wrap.appendChild(list);
    wrap.appendChild(feature);
    bodyEl.insertBefore(wrap, typing);

    // Select the first spot by default.
    if (list.firstChild) list.firstChild.classList.add('on');
    selectSpot(feature, spots[0]);
  }

  // Paint the feature pane (hero image + VIEW LOCATION + LOLA'S PICK card).
  function selectSpot(feature, s) {
    var hasGeo = (s.lat != null && s.lng != null);
    var bg = s.image ? 'background-image:url(\'' + String(s.image).replace(/'/g, '') + '\');' : '';
    feature.innerHTML =
      '<div class="lo-hero" style="' + bg + '">' +
        (s.image ? '' : '<span class="lo-hero-ph">' + spotInitial(s.name) + '</span>') +
        (hasGeo ? '<button class="lo-view">VIEW LOCATION</button>' : '') +
      '</div>' +
      '<div class="lo-pick">' +
        '<div class="lo-pick-top">' +
          '<div class="lo-pick-id">' +
            '<div class="lo-pick-label">LOLA’S PICK</div>' +
            '<div class="lo-pick-name">' + escapeHtml(s.name) + '</div>' +
          '</div>' +
          (s.address ? '<div class="lo-pick-addr">' + escapeHtml(s.address) + '</div>' : '') +
        '</div>' +
        (s.rating ? starsHtml(s.rating) : '') +
        '<div class="lo-pick-desc">' + escapeHtml(s.description || s.reason || '') + '</div>' +
      '</div>';
    var view = feature.querySelector('.lo-view');
    if (view) view.addEventListener('click', function () {
      goToSpot({ lat: Number(s.lat), lng: Number(s.lng), name: s.name || 'Spot' });
    });
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function renderFlights(payload) {
    payload = payload || {};
    var wrap = document.createElement('div');
    wrap.className = 'lola-actions';
    var card = document.createElement('div');
    card.className = 'lola-card';
    card.innerHTML =
      '<div class="lo-cat">Flights</div>' +
      '<div class="lo-name">' + escapeHtml(payload.origin || 'You') + ' → ' + escapeHtml(payload.destination || 'Them') + '</div>';
    var btn = document.createElement('button');
    btn.className = 'lola-go';
    btn.textContent = 'Open Flights →';
    btn.addEventListener('click', function () { openFlights(payload); });
    card.appendChild(btn);
    wrap.appendChild(card);
    bodyEl.insertBefore(wrap, typing);
  }

  function renderPlaylistDraft(payload) {
    payload = payload || {};
    var tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
    var wrap = document.createElement('div');
    wrap.className = 'lola-actions';
    var card = document.createElement('div');
    card.className = 'lola-card';
    var list = tracks.slice(0, 8).map(function (t) {
      return '<li>' + escapeHtml(t.title || '') + (t.artist ? ' — <span>' + escapeHtml(t.artist) + '</span>' : '') + '</li>';
    }).join('');
    card.innerHTML =
      '<div class="lo-cat">Playlist draft</div>' +
      '<div class="lo-name">' + escapeHtml(payload.name || 'For us') + '</div>' +
      '<ul class="lo-tracks">' + list + '</ul>';
    var btn = document.createElement('button');
    btn.className = 'lola-go';
    btn.textContent = 'Save playlist →';
    btn.addEventListener('click', function () { savePlaylistDraft(payload, btn); });
    card.appendChild(btn);
    wrap.appendChild(card);
    bodyEl.insertBefore(wrap, typing);
  }

  // "Go to Spot": if a goToSpot() exists on the current page (LoveConnect map),
  // drive it directly; otherwise hand off to LoveConnect with the spot in the URL.
  function goToSpot(spot) {
    if (typeof window.goToSpot === 'function' && window.goToSpot !== goToSpot) {
      window.goToSpot(spot);
      return;
    }
    var q = 'spotLat=' + encodeURIComponent(spot.lat) +
            '&spotLng=' + encodeURIComponent(spot.lng) +
            '&spotName=' + encodeURIComponent(spot.name || 'Spot');
    window.location.href = '/loveconnect.html?' + q;
  }

  function openFlights(payload) {
    var q = 'from=' + encodeURIComponent(payload.origin || '') +
            '&to=' + encodeURIComponent(payload.destination || '');
    window.location.href = '/flights.html?' + q;
  }

  function savePlaylistDraft(payload, btn) {
    var token = localStorage.getItem('loveflix_token');
    if (!token) { btn.textContent = 'Sign in to save'; return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    fetch('/api/music/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ name: payload.name || 'For us' }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (pl) {
        var id = pl && (pl.id || (pl.playlist && pl.playlist.id));
        if (!id) { btn.textContent = 'Saved ♥'; return; }
        var tracks = Array.isArray(payload.tracks) ? payload.tracks.slice(0, 8) : [];
        return Promise.all(tracks.map(function (t) {
          return fetch('/api/music/playlists/' + id + '/songs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ title: t.title, artist: t.artist }),
          }).catch(function () {});
        })).then(function () { btn.textContent = 'Saved ♥'; });
      })
      .catch(function () { btn.disabled = false; btn.textContent = 'Try again'; });
  }

  document.getElementById('lolaSend').addEventListener('click', function () { send(field.value); });
  field.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(field.value); });

  // ── Open / close ──────────────────────────────────────────────────────────
  function open() {
    if (isOpen) return;
    isOpen = true;
    panel.classList.add('lola-open');
    if (logo) logo.classList.add('lola-active');
    greet();
    setTimeout(function () { try { field.focus(); } catch (e) {} }, 360);
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.remove('lola-open');
    if (logo) logo.classList.remove('lola-active');
  }
  function toggle() { isOpen ? close() : open(); }

  document.getElementById('lolaClose').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  window.Lola = { open: open, close: close, toggle: toggle };

  // ── Restore persisted panel size ────────────────────────────────────────
  try {
    var sz = JSON.parse(localStorage.getItem(LS_SIZE) || 'null');
    if (sz && !isMobile) { panel.style.width = sz.w + 'px'; panel.style.height = sz.h + 'px'; }
  } catch (e) {}

  // ── Launcher: drag anywhere + click-to-open ───────────────────────────────
  if (logo) {
    // restore saved position
    try {
      var pos = JSON.parse(localStorage.getItem(LS_POS) || 'null');
      if (pos && !isMobile) {
        logo.style.left = pos.x + 'px'; logo.style.top = pos.y + 'px';
        logo.style.right = 'auto'; logo.style.bottom = 'auto';
      }
    } catch (e) {}

    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    logo.addEventListener('pointerdown', function (e) {
      if (isMobile) return; // tap-only on mobile
      dragging = true; moved = false;
      var r = logo.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      logo.setPointerCapture(e.pointerId);
      logo.classList.add('lola-dragging');
    });
    logo.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      var nx = Math.max(4, Math.min(window.innerWidth - logo.offsetWidth - 4, ox + dx));
      var ny = Math.max(4, Math.min(window.innerHeight - logo.offsetHeight - 4, oy + dy));
      logo.style.left = nx + 'px'; logo.style.top = ny + 'px';
      logo.style.right = 'auto'; logo.style.bottom = 'auto';
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      logo.classList.remove('lola-dragging');
      try { logo.releasePointerCapture(e.pointerId); } catch (err) {}
      if (moved) {
        var r = logo.getBoundingClientRect();
        try { localStorage.setItem(LS_POS, JSON.stringify({ x: r.left, y: r.top })); } catch (err) {}
      }
    }
    logo.addEventListener('pointerup', function (e) {
      var wasMoved = moved;
      endDrag(e);
      if (!wasMoved) toggle();
    });
    logo.addEventListener('pointercancel', endDrag);
    logo.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    logo.addEventListener('mouseenter', function () {
      if (tip && !isMobile) {
        var r = logo.getBoundingClientRect();
        tip.style.left = 'auto';
        tip.style.right = (window.innerWidth - r.left + 12) + 'px';
        tip.style.bottom = (window.innerHeight - r.bottom + 14) + 'px';
        tip.style.opacity = isOpen ? '0' : '1';
      }
    });
    logo.addEventListener('mouseleave', function () { if (tip) tip.style.opacity = '0'; });
  }

  // ── Panel: drag by header + resize from top-left handle ───────────────────
  if (!isMobile) {
    var head = document.getElementById('lolaHead');
    var hDrag = false, hsx = 0, hsy = 0, hl = 0, ht = 0;
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.lola-close')) return;
      hDrag = true;
      var r = panel.getBoundingClientRect();
      hl = r.left; ht = r.top; hsx = e.clientX; hsy = e.clientY;
      // switch to top/left positioning so dragging is absolute
      panel.style.left = hl + 'px'; panel.style.top = ht + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!hDrag) return;
      var nx = Math.max(4, Math.min(window.innerWidth - 80, hl + e.clientX - hsx));
      var ny = Math.max(4, Math.min(window.innerHeight - 60, ht + e.clientY - hsy));
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
    });
    function endHead(e) { if (hDrag) { hDrag = false; try { head.releasePointerCapture(e.pointerId); } catch (err) {} } }
    head.addEventListener('pointerup', endHead);
    head.addEventListener('pointercancel', endHead);

    var rz = document.getElementById('lolaResize');
    var rDrag = false, rsx = 0, rsy = 0, rw = 0, rh = 0, rRight = 0, rBottom = 0;
    rz.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      rDrag = true;
      var r = panel.getBoundingClientRect();
      rw = r.width; rh = r.height; rsx = e.clientX; rsy = e.clientY;
      rRight = window.innerWidth - r.right; rBottom = window.innerHeight - r.bottom;
      // anchor bottom-right so resizing from top-left grows naturally
      panel.style.left = 'auto'; panel.style.top = 'auto';
      panel.style.right = rRight + 'px'; panel.style.bottom = rBottom + 'px';
      rz.setPointerCapture(e.pointerId);
    });
    rz.addEventListener('pointermove', function (e) {
      if (!rDrag) return;
      var nw = Math.max(300, Math.min(window.innerWidth - 40, rw - (e.clientX - rsx)));
      var nh = Math.max(360, Math.min(window.innerHeight - 40, rh - (e.clientY - rsy)));
      panel.style.width = nw + 'px'; panel.style.height = nh + 'px';
    });
    function endRz(e) {
      if (!rDrag) return;
      rDrag = false;
      try { rz.releasePointerCapture(e.pointerId); } catch (err) {}
      try { localStorage.setItem(LS_SIZE, JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight })); } catch (err) {}
    }
    rz.addEventListener('pointerup', endRz);
    rz.addEventListener('pointercancel', endRz);
  }
})();
