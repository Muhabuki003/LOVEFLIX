// loveflix-call.js — LiveKit-powered video/audio calling for LOVEFLIX
// Drop-in replacement for the WebRTC version.
// UI is 100% identical — FaceTime-style floating card, incoming overlay, status bar.
// Only the media transport layer has changed (LiveKit SFU instead of raw P2P WebRTC).
(function (global) {
  'use strict';

  // ─── CONFIG ───────────────────────────────────────────────────────────────────
  // Token endpoint — your Cloudflare Worker URL.
  // In production set this to: https://loveflix.so/api/livekit-token
  // or your workers.dev subdomain during testing.
  var TOKEN_ENDPOINT = '/api/livekit-token';

  // LiveKit JS SDK loaded from CDN (injected once)
  var LK_SDK_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2.19.0/dist/livekit-client.umd.min.js';

  // ─── SUPABASE REALTIME MINI-CLIENT (kept for incoming-call signalling ring) ──
  // LiveKit handles actual media; Supabase Realtime still handles the
  // "hey, someone is calling you" notification so the callee can join the room.
  function RealtimeChannel(sbUrl, anonKey, token, channelName) {
    this._wsUrl = sbUrl.replace(/^https?/, function(p){ return p==='https'?'wss':'ws'; })
                  + '/realtime/v1/websocket?apikey=' + anonKey + '&vsn=1.0.0';
    this._token    = token;
    this._channel  = 'realtime:' + channelName;
    this._ws       = null;
    this._ref      = 0;
    this._handlers = {};
    this._ready    = false;
    this._queue    = [];
    this._closed   = false;
    this._hbTimer  = null;
    this._retTimer = null;
  }

  RealtimeChannel.prototype.connect = function () {
    if (this._closed) return;
    var self = this;
    try { this._ws = new WebSocket(this._wsUrl); } catch(e) { return; }

    this._ws.onopen = function () {
      self._send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: self._nextRef() });
      self._send({
        topic: self._channel,
        event: 'phx_join',
        payload: { config: { broadcast: { self: false } }, access_token: self._token },
        ref: self._nextRef()
      });
      self._hbTimer = setInterval(function () {
        if (self._ws && self._ws.readyState === 1)
          self._send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: self._nextRef() });
      }, 28000);
    };

    this._ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.event === 'phx_reply' && msg.payload && msg.payload.status === 'ok' && msg.topic === self._channel) {
          self._ready = true;
          self._queue.forEach(function(m){ self._send(m); });
          self._queue = [];
        }
        if (msg.event === 'broadcast' && msg.payload && msg.payload.event) {
          var h = self._handlers[msg.payload.event];
          if (h) h(msg.payload.payload || {});
        }
      } catch (_) {}
    };

    this._ws.onclose = function () {
      self._ready = false;
      clearInterval(self._hbTimer);
      if (!self._closed) self._retTimer = setTimeout(function(){ self.connect(); }, 3500);
    };
  };

  RealtimeChannel.prototype.on      = function (ev, fn) { this._handlers[ev] = fn; return this; };
  RealtimeChannel.prototype.close   = function () {
    this._closed = true;
    clearInterval(this._hbTimer);
    clearTimeout(this._retTimer);
    if (this._ws) try { this._ws.close(); } catch(_){}
  };
  RealtimeChannel.prototype._send   = function (msg) {
    if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(msg));
  };
  RealtimeChannel.prototype._nextRef = function () { return String(++this._ref); };
  RealtimeChannel.prototype.broadcast = function (event, payload) {
    var msg = {
      topic: this._channel,
      event: 'broadcast',
      payload: { type: 'broadcast', event: event, payload: payload },
      ref: this._nextRef()
    };
    if (this._ready) this._send(msg);
    else this._queue.push(msg);
  };

  // ─── SESSION STATE ────────────────────────────────────────────────────────────
  var SS_KEY = 'loveflix_call';
  function getCallState()  { try { return JSON.parse(sessionStorage.getItem(SS_KEY)||'null'); } catch(_){ return null; } }
  function setCallState(s) { if(s) sessionStorage.setItem(SS_KEY, JSON.stringify(s)); else sessionStorage.removeItem(SS_KEY); }

  // ─── CSS (identical to original) ─────────────────────────────────────────────
  var CALL_CSS = '<style id="lf-call-css">'
    + '#lf-call-bar{'
    +   'position:fixed;bottom:0;left:0;right:0;z-index:9999;'
    +   'background:linear-gradient(135deg,#120606 0%,#1e0a0a 100%);'
    +   'border-top:1px solid rgba(220,38,38,.35);'
    +   'display:none;align-items:center;gap:12px;padding:10px 18px;'
    +   'box-shadow:0 -4px 30px rgba(0,0,0,.7);font-family:Inter,sans-serif;}'
    + '#lf-call-bar.lf-active{display:flex;}'
    + '.lf-cb-pulse{'
    +   'width:10px;height:10px;border-radius:50%;background:#22c55e;flex-shrink:0;'
    +   'box-shadow:0 0 0 0 rgba(34,197,94,.7);animation:lf-ring 1.6s ease-out infinite;}'
    + '#lf-call-bar.lf-calling .lf-cb-pulse{background:#eab308;animation:lf-ring-y 1.6s ease-out infinite;}'
    + '#lf-call-bar.lf-incoming .lf-cb-pulse{background:#3b82f6;animation:lf-ring-b 1.6s ease-out infinite;}'
    + '@keyframes lf-ring  {0%{box-shadow:0 0 0 0 rgba(34,197,94,.7)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}'
    + '@keyframes lf-ring-y{0%{box-shadow:0 0 0 0 rgba(234,179,8,.7)} 70%{box-shadow:0 0 0 8px rgba(234,179,8,0)} 100%{box-shadow:0 0 0 0 rgba(234,179,8,0)}}'
    + '@keyframes lf-ring-b{0%{box-shadow:0 0 0 0 rgba(59,130,246,.7)}70%{box-shadow:0 0 0 8px rgba(59,130,246,0)}100%{box-shadow:0 0 0 0 rgba(59,130,246,0)}}'
    + '.lf-cb-info{flex:1;min-width:0;}'
    + '.lf-cb-title{font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.lf-cb-sub{font-size:11px;color:rgba(255,255,255,.45);margin-top:2px;}'
    + '.lf-cb-actions{display:flex;gap:8px;flex-shrink:0;}'
    + '.lf-cb-btn{'
    +   'width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;'
    +   'display:flex;align-items:center;justify-content:center;'
    +   'background:rgba(255,255,255,.1);color:#fff;transition:background .2s;}'
    + '.lf-cb-btn:hover{background:rgba(255,255,255,.2);}'
    + '.lf-cb-btn.lf-danger{background:#dc2626;}'
    + '.lf-cb-btn.lf-danger:hover{background:#b91c1c;}'
    + '.lf-cb-btn.lf-accept{background:#16a34a;}'
    + '.lf-cb-btn.lf-accept:hover{background:#15803d;}'
    + '.lf-cb-btn.lf-muted{background:rgba(220,38,38,.45);}'
    + '#lf-video-wrap{'
    +   'position:fixed;bottom:66px;right:16px;z-index:9998;'
    +   'width:290px;height:390px;border-radius:20px;overflow:hidden;'
    +   'box-shadow:0 12px 48px rgba(0,0,0,.92);background:#0d0505;'
    +   'display:none;border:2px solid rgba(220,38,38,.45);'
    +   'touch-action:none;user-select:none;}'
    + '#lf-video-wrap.lf-visible{display:block;}'
    + '#lf-remote-vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}'
    + '#lf-no-vid{'
    +   'position:absolute;inset:0;display:flex;flex-direction:column;'
    +   'align-items:center;justify-content:center;gap:14px;background:#0d0505;}'
    + '#lf-no-vid-av{'
    +   'width:88px;height:88px;border-radius:50%;'
    +   'background:linear-gradient(135deg,#dc2626,#7f1d1d);'
    +   'display:flex;align-items:center;justify-content:center;'
    +   'font-size:36px;font-weight:700;color:#fff;font-family:"Bebas Neue",sans-serif;'
    +   'animation:lf-av-pulse 2s ease-in-out infinite;}'
    + '@keyframes lf-av-pulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.5)}50%{box-shadow:0 0 0 18px rgba(220,38,38,0)}}'
    + '#lf-no-vid-name{font-size:13px;color:rgba(255,255,255,.5);font-family:Inter,sans-serif;}'
    + '#lf-vid-drag{'
    +   'position:absolute;top:0;left:0;right:0;height:48px;cursor:move;z-index:3;'
    +   'background:linear-gradient(180deg,rgba(0,0,0,.65) 0%,transparent 100%);'
    +   'display:flex;align-items:center;padding:0 10px;gap:8px;}'
    + '#lf-vid-drag-dots{flex:1;display:flex;align-items:center;justify-content:center;gap:3px;}'
    + '.lf-drag-dot{width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.35);}'
    + '#lf-vid-label{font-size:12px;font-weight:600;color:rgba(255,255,255,.85);font-family:Inter,sans-serif;text-shadow:0 1px 4px rgba(0,0,0,.8);}'
    + '#lf-vid-min,#lf-vid-fs{width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,.18);'
    +   'border:none;cursor:pointer;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;}'
    + '#lf-vid-min:hover,#lf-vid-fs:hover{background:rgba(255,255,255,.3);}'
    + '#lf-vid-resize{position:absolute;bottom:0;right:0;width:20px;height:20px;'
    +   'cursor:nwse-resize;z-index:5;opacity:.45;transition:opacity .2s;}'
    + '#lf-vid-resize:hover{opacity:.9;}'
    + '#lf-share-overlay{position:fixed;top:0;left:0;right:0;bottom:0;z-index:10002;background:#000;'
    +   'display:none;flex-direction:column;}'
    + '#lf-share-overlay.lf-visible{display:flex;}'
    + '#lf-share-vid{flex:1;width:100%;object-fit:contain;background:#000;display:block;}'
    + '#lf-share-bar{position:absolute;top:0;left:0;right:0;'
    +   'background:linear-gradient(180deg,rgba(0,0,0,.85) 0%,transparent 100%);'
    +   'padding:12px 16px;display:flex;align-items:center;gap:10px;}'
    + '#lf-share-label{flex:1;font-size:13px;color:rgba(255,255,255,.8);font-family:Inter,sans-serif;}'
    + '#lf-share-close{background:rgba(255,255,255,.18);border:none;border-radius:50%;'
    +   'width:32px;height:32px;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;}'
    + '#lf-share-close:hover{background:rgba(255,255,255,.3);}'
    + '#lf-share-pip{position:absolute;bottom:20px;right:20px;width:160px;height:100px;'
    +   'border-radius:12px;overflow:hidden;border:2px solid rgba(255,255,255,.3);background:#111;}'
    + '#lf-share-pip video{width:100%;height:100%;object-fit:cover;}'
    + '.lf-vbtn.lf-sharing{background:rgba(59,130,246,.55);}'
    + '#lf-my-video{'
    +   'position:absolute;bottom:60px;left:10px;z-index:2;'
    +   'width:84px;height:64px;border-radius:11px;overflow:hidden;'
    +   'border:2px solid rgba(255,255,255,.45);background:#111;cursor:pointer;}'
    + '#lf-my-video video{width:100%;height:100%;object-fit:cover;}'
    + '#lf-vid-controls{'
    +   'position:absolute;bottom:0;left:0;right:0;height:56px;z-index:2;'
    +   'background:linear-gradient(0deg,rgba(0,0,0,.8) 0%,transparent 100%);'
    +   'display:flex;align-items:center;justify-content:center;gap:14px;padding-bottom:6px;}'
    + '.lf-vbtn{'
    +   'width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;'
    +   'display:flex;align-items:center;justify-content:center;'
    +   'background:rgba(255,255,255,.18);color:#fff;transition:background .18s,transform .15s;}'
    + '.lf-vbtn:hover{background:rgba(255,255,255,.3);transform:scale(1.07);}'
    + '.lf-vbtn.lf-muted{background:rgba(220,38,38,.5);}'
    + '.lf-vbtn.lf-danger{background:#dc2626;}'
    + '.lf-vbtn.lf-danger:hover{background:#b91c1c;}'
    + '#lf-inc-overlay{'
    +   'position:fixed;top:0;left:0;right:0;bottom:0;'
    +   'background:rgba(0,0,0,.9);z-index:10000;'
    +   'display:none;align-items:center;justify-content:center;flex-direction:column;gap:16px;}'
    + '#lf-inc-overlay.lf-visible{display:flex;}'
    + '#lf-inc-av{'
    +   'width:88px;height:88px;border-radius:50%;'
    +   'background:linear-gradient(135deg,#dc2626,#7f1d1d);'
    +   'display:flex;align-items:center;justify-content:center;'
    +   'font-size:36px;font-weight:700;color:#fff;font-family:"Bebas Neue",sans-serif;'
    +   'animation:lf-inc-ring 1.4s ease-out infinite;}'
    + '@keyframes lf-inc-ring{0%{box-shadow:0 0 0 0 rgba(220,38,38,.7)}70%{box-shadow:0 0 0 24px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}'
    + '#lf-inc-name{font-size:32px;font-weight:700;color:#fff;font-family:"Bebas Neue",sans-serif;letter-spacing:1.5px;text-align:center;}'
    + '#lf-inc-sub{font-size:13px;color:rgba(255,255,255,.45);}'
    + '.lf-inc-actions{display:flex;gap:36px;margin-top:14px;}'
    + '.lf-inc-btn{'
    +   'width:72px;height:72px;border-radius:50%;border:none;cursor:pointer;'
    +   'display:flex;align-items:center;justify-content:center;color:#fff;'
    +   'transition:transform .15s,box-shadow .15s;}'
    + '.lf-inc-btn:hover{transform:scale(1.1);}'
    + '.lf-inc-accept{background:#16a34a;box-shadow:0 0 0 0 rgba(22,163,74,.6);animation:lf-acc-ring 1.6s ease-out infinite;}'
    + '@keyframes lf-acc-ring{0%{box-shadow:0 0 0 0 rgba(22,163,74,.6)}70%{box-shadow:0 0 0 14px rgba(22,163,74,0)}100%{box-shadow:0 0 0 0 rgba(22,163,74,0)}}'
    + '.lf-inc-decline{background:#dc2626;}'
    + '</style>';

  // ─── HTML (identical to original) ────────────────────────────────────────────
  var INC_HTML = '<div id="lf-inc-overlay" role="dialog" aria-modal="true" aria-label="Incoming call">'
    + '<div id="lf-inc-av" aria-hidden="true">M</div>'
    + '<div id="lf-inc-name" role="alert">Incoming Call</div>'
    + '<div id="lf-inc-sub">LoveConnect · Encrypted</div>'
    + '<div class="lf-inc-actions">'
    + '<button class="lf-inc-btn lf-inc-decline" id="lf-inc-dec" title="Decline" aria-label="Decline call">'
    + '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 01-1.41-.04L.29 13.08a1 1 0 010-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 010 1.41l-2.48 2.45a1 1 0 01-1.41.04 11.66 11.66 0 00-2.66-1.85c-.33-.16-.56-.51-.56-.9v-3.1A15.7 15.7 0 0012 9z" transform="rotate(135 12 12)"/></svg>'
    + '</button>'
    + '<button class="lf-inc-btn lf-inc-accept" id="lf-inc-acc" title="Accept" aria-label="Accept call">'
    + '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 15.5c-1.25 0-2.45-.2-3.57-.57a1 1 0 00-1.02.24l-2.2 2.2a15.04 15.04 0 01-6.59-6.59l2.2-2.21a1 1 0 00.25-1.01A11.36 11.36 0 018.5 4a1 1 0 00-1-1H4a1 1 0 00-1 1c0 9.39 7.61 17 17 17a1 1 0 001-1v-3.5a1 1 0 00-1-1z"/></svg>'
    + '</button>'
    + '</div>'
    + '</div>';

  var VID_HTML = '<div id="lf-video-wrap" role="dialog" aria-modal="true" aria-label="Video call">'
    + '<video id="lf-remote-vid" autoplay playsinline></video>'
    + '<div id="lf-no-vid">'
    +   '<div id="lf-no-vid-av" aria-hidden="true">M</div>'
    +   '<div id="lf-no-vid-name">Connecting...</div>'
    + '</div>'
    + '<div id="lf-vid-drag">'
    +   '<span id="lf-vid-label">On call</span>'
    +   '<div id="lf-vid-drag-dots" aria-hidden="true"><span class="lf-drag-dot"></span><span class="lf-drag-dot"></span><span class="lf-drag-dot"></span><span class="lf-drag-dot"></span><span class="lf-drag-dot"></span></div>'
    +   '<button id="lf-vid-fs" title="Fullscreen" aria-label="Toggle fullscreen"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg></button>'
    +   '<button id="lf-vid-min" title="Minimize" aria-label="Minimize video call">&#8722;</button>'
    + '</div>'
    + '<div id="lf-my-video"><video id="lf-local-vid" autoplay playsinline muted></video></div>'
    + '<div id="lf-vid-controls">'
    +   '<button class="lf-vbtn" id="lf-vid-mute" title="Mute" aria-label="Mute microphone" aria-pressed="false">'
    +     '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3zm5.91-3a.9.9 0 00-.91.91A4.96 4.96 0 0112 17a4.96 4.96 0 01-5-5.09.91.91 0 10-1.82 0A6.78 6.78 0 0011 18.71V21a1 1 0 002 0v-2.29a6.78 6.78 0 005.82-6.8.91.91 0 00-.91-.91z"/></svg>'
    +   '</button>'
    +   '<button class="lf-vbtn lf-danger" id="lf-vid-hang" title="End call" aria-label="End call">'
    +     '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 01-1.41-.04L.29 13.08a1 1 0 010-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 010 1.41l-2.48 2.45a1 1 0 01-1.41.04 11.66 11.66 0 00-2.66-1.85c-.33-.16-.56-.51-.56-.9v-3.1A15.7 15.7 0 0012 9z" transform="rotate(135 12 12)"/></svg>'
    +   '</button>'
    +   '<button class="lf-vbtn" id="lf-vid-cam" title="Toggle camera" aria-label="Toggle camera" aria-pressed="true">'
    +     '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg>'
    +   '</button>'
    +   '<button class="lf-vbtn" id="lf-vid-share" title="Share screen" aria-label="Share screen">'
    +     '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg>'
    +   '</button>'
    + '</div>'
    + '<div id="lf-vid-resize" aria-hidden="true">'
    +   '<svg width="20" height="20" viewBox="0 0 24 24" fill="rgba(255,255,255,.6)"><path d="M22 22H20V20H22V22ZM22 18H20V16H22V18ZM18 22H16V20H18V22ZM14 22H12V20H14V22ZM22 14H20V12H22V14Z"/></svg>'
    + '</div>'
    + '</div>'
    + '<div id="lf-share-overlay" role="region" aria-label="Screen share">'
    +   '<video id="lf-share-vid" autoplay playsinline></video>'
    +   '<div id="lf-share-bar">'
    +     '<span id="lf-share-label">&#128250; Sharing screen</span>'
    +     '<button id="lf-share-close" aria-label="Close screen share"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>'
    +   '</div>'
    +   '<div id="lf-share-pip"><video id="lf-share-pip-vid" autoplay playsinline></video></div>'
    + '</div>';

  var BAR_HTML = '<div id="lf-call-bar" role="region" aria-label="Ongoing call">'
    + '<div class="lf-cb-pulse" aria-hidden="true"></div>'
    + '<div class="lf-cb-info">'
    +   '<div class="lf-cb-title" id="lf-cb-title">On call</div>'
    +   '<div class="lf-cb-sub" id="lf-cb-sub">00:00</div>'
    + '</div>'
    + '<div class="lf-cb-actions">'
    +   '<button class="lf-cb-btn" id="lf-cb-restore" title="Show video" aria-label="Show video" style="display:none">'
    +     '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg>'
    +   '</button>'
    +   '<button class="lf-cb-btn" id="lf-cb-mute" title="Mute" aria-label="Mute microphone" aria-pressed="false">'
    +     '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3zm5.91-3a.9.9 0 00-.91.91A4.96 4.96 0 0112 17a4.96 4.96 0 01-5-5.09.91.91 0 10-1.82 0A6.78 6.78 0 0011 18.71V21a1 1 0 002 0v-2.29a6.78 6.78 0 005.82-6.8.91.91 0 00-.91-.91z"/></svg>'
    +   '</button>'
    +   '<button class="lf-cb-btn lf-danger" id="lf-cb-hang" title="End call" aria-label="End call">'
    +     '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 01-1.41-.04L.29 13.08a1 1 0 010-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 010 1.41l-2.48 2.45a1 1 0 01-1.41.04 11.66 11.66 0 00-2.66-1.85c-.33-.16-.56-.51-.56-.9v-3.1A15.7 15.7 0 0012 9z" transform="rotate(135 12 12)"/></svg>'
    +   '</button>'
    +   '<button class="lf-cb-btn lf-accept" id="lf-cb-acc" style="display:none" title="Accept" aria-label="Accept call">'
    +     '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 15.5c-1.25 0-2.45-.2-3.57-.57a1 1 0 00-1.02.24l-2.2 2.2a15.04 15.04 0 01-6.59-6.59l2.2-2.21a1 1 0 00.25-1.01A11.36 11.36 0 018.5 4a1 1 0 00-1-1H4a1 1 0 00-1 1c0 9.39 7.61 17 17 17a1 1 0 001-1v-3.5a1 1 0 00-1-1z"/></svg>'
    +   '</button>'
    + '</div>'
    + '</div>';

  // ─── INJECT UI ────────────────────────────────────────────────────────────────
  function injectUI() {
    if (document.getElementById('lf-call-bar')) return;
    document.head.insertAdjacentHTML('beforeend', CALL_CSS);
    document.body.insertAdjacentHTML('beforeend', INC_HTML + VID_HTML + BAR_HTML);
  }

  // ─── LOAD LIVEKIT SDK (CDN, once) ────────────────────────────────────────────
  var _sdkReady   = false;
  var _sdkWaiters = [];

  function _loadSDK(cb) {
    if (_sdkReady) { cb(); return; }
    _sdkWaiters.push(cb);
    if (document.getElementById('lf-lk-sdk')) return; // already loading
    var s = document.createElement('script');
    s.id  = 'lf-lk-sdk';
    s.src = LK_SDK_URL;
    s.onload = function () {
      _sdkReady = true;
      _sdkWaiters.forEach(function(fn){ fn(); });
      _sdkWaiters = [];
    };
    document.head.appendChild(s);
  }

  // ─── INTERNAL STATE ───────────────────────────────────────────────────────────
  var _room           = null;   // LiveKit Room instance
  var _sigCh          = null;   // Supabase Realtime — ring/notify only
  var _vsyncCh        = null;
  var _timer          = null;
  var _ringTimer      = null;   // interval that re-broadcasts ring until partner joins
  var _sigRetry       = null;   // timeout to retry opening signal channel
  var _reconnectTimer = null;   // grace period before giving up on a navigating partner
  var _pageUnloading  = false;  // set on pagehide so Disconnected doesn't wipe sessionStorage
  var _sec       = 0;
  var _muted     = false;
  var _camOff    = false;
  var _myId      = null;
  var _coupleId  = null;
  var _pName     = 'My Love';
  var _pInitial  = 'M';
  var _myName    = 'Me';
  var _myInitial = 'M';
  var _pendRing  = null;   // pending incoming ring payload
  var _minimized = false;
  var _hasRemoteVideo = false;
  var _isCaller      = false; // true when this side initiated the call (the only side that writes call history)
  var _callLogId     = null;  // id of the inserted 'answered' row, set on connect
  var _outcomeLogged = false; // guards against double-logging a missed/declined outcome

  function _lf() { return typeof LoveFlix !== 'undefined' ? LoveFlix : null; }
  function _creds() {
    var lf = _lf(); if (!lf) return null;
    return { url: lf.SUPABASE_URL, key: lf.SUPABASE_ANON_KEY,
             token: lf.getToken(), userId: lf.getUserId(), coupleId: lf.getCoupleId() };
  }
  function _el(id) { return document.getElementById(id); }

  // ─── UI HELPERS (identical behaviour to original) ────────────────────────────
  function _barMode(mode) {
    var b = _el('lf-call-bar'); if (!b) return;
    b.className = 'lf-active' + (mode ? ' lf-' + mode : '');
    var acc = _el('lf-cb-acc');
    if (acc) acc.style.display = mode === 'incoming' ? '' : 'none';
  }
  function _hideBar()  { var b = _el('lf-call-bar'); if (b) b.className = ''; }
  function _setTitle(t, sub) {
    var el = _el('lf-cb-title'); if (el) el.textContent = t;
    var vl = _el('lf-vid-label'); if (vl) vl.textContent = t;
    if (sub !== undefined) { var s = _el('lf-cb-sub'); if (s) s.textContent = sub; }
  }
  function _showVideo() {
    var w = _el('lf-video-wrap'); if (w) w.classList.add('lf-visible');
    var r = _el('lf-cb-restore'); if (r) r.style.display = 'none';
    _minimized = false;
  }
  function _hideVideo() {
    var w = _el('lf-video-wrap'); if (w) w.classList.remove('lf-visible');
    var r = _el('lf-cb-restore'); if (r) r.style.display = '';
    _minimized = true;
  }
  function _updateVideoPlaceholder() {
    var rv  = _el('lf-remote-vid');
    var nv  = _el('lf-no-vid');
    var nav = _el('lf-no-vid-av');
    var nan = _el('lf-no-vid-name');
    if (_hasRemoteVideo) {
      if (rv) rv.style.display = 'block';
      if (nv) nv.style.display = 'none';
    } else {
      if (rv) rv.style.display = 'none';
      if (nv) nv.style.display = 'flex';
      if (nav) nav.textContent = _pInitial;
      if (nan) nan.textContent = 'Connecting...';
    }
  }
  function _startTimer() {
    _sec = 0; clearInterval(_timer);
    _timer = setInterval(function () {
      _sec++;
      var el = _el('lf-cb-sub'); if (el) el.textContent = _pad(_sec);
    }, 1000);
  }
  function _pad(s) {
    var m = Math.floor(s/60), sec = s%60;
    return (m<10?'0':'')+m+':'+(sec<10?'0':'')+sec;
  }
  function _stopTimer() { clearInterval(_timer); _timer = null; }

  // ─── LIVEKIT TOKEN FETCH ──────────────────────────────────────────────────────
  async function _fetchToken(roomName, identity) {
    var creds = _creds();
    var headers = { 'Content-Type': 'application/json' };
    if (creds && creds.token) headers['Authorization'] = 'Bearer ' + creds.token;

    var res = await fetch(TOKEN_ENDPOINT, {
      method:  'POST',
      headers: headers,
      body:    JSON.stringify({ roomName: roomName, identity: identity })
    });
    if (!res.ok) {
      var errBody = {};
      try { errBody = await res.json(); } catch(_) {}
      var reason = errBody.error || 'token_fetch_failed';
      throw new Error(reason + ' (' + res.status + ')');
    }
    var data = await res.json();
    if (!data.url) throw new Error('livekit_url_missing — set LIVEKIT_URL secret in Cloudflare Pages');
    if (!data.token) throw new Error('livekit_token_missing — check LIVEKIT_API_KEY/SECRET in Cloudflare Pages');
    return data;
  }

  // ─── LIVEKIT ROOM SETUP ───────────────────────────────────────────────────────
  async function _joinRoom(roomName, identity) {
    var LK   = window.LivekitClient;
    var data = await _fetchToken(roomName, identity);

    if (_room) {
      try { await _room.disconnect(); } catch(_){}
      _room = null;
    }

    _room = new LK.Room({
      adaptiveStream:   true,   // adjusts quality to rendered size
      dynacast:         true,   // pauses unused video layers
      videoCaptureDefaults: {
        resolution:     LK.VideoPresets.h720.resolution,  // 1280×720
      },
      audioCaptureDefaults: {
        echoCancellation:    true,
        noiseSuppression:    true,
        autoGainControl:     true,
      },
    });

    // ── Remote track handlers ────────────────────────────────────────────────
    _room.on(LK.RoomEvent.TrackSubscribed, function(track, pub, participant) {
      if (track.kind === LK.Track.Kind.Video) {
        if (pub && pub.source === LK.Track.Source.ScreenShare) {
          _showRemoteScreenShare(track);
        } else {
          var rv = _el('lf-remote-vid');
          if (rv) {
            track.attach(rv);
            _hasRemoteVideo = true;
            _updateVideoPlaceholder();
            _showVideo();
          }
        }
      } else if (track.kind === LK.Track.Kind.Audio) {
        var audioEl = track.attach();
        if (audioEl && !audioEl.parentNode) document.body.appendChild(audioEl);
        // Resume audio context if browser blocked autoplay
        if (_room) try { _room.startAudio(); } catch(_) {}
      }
    });

    _room.on(LK.RoomEvent.TrackUnsubscribed, function(track, pub) {
      if (track.kind === LK.Track.Kind.Video) {
        if (pub && pub.source === LK.Track.Source.ScreenShare) {
          track.detach();
          _stopShareOverlay();
        } else {
          track.detach();
          _hasRemoteVideo = false;
          _updateVideoPlaceholder();
        }
      } else if (track.kind === LK.Track.Kind.Audio) {
        track.detach();
      }
    });

    _room.on(LK.RoomEvent.ParticipantConnected, function() {
      // Cancel reconnection grace period if partner came back after navigating
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
      _clearRingTimer();
      _barMode('');
      _setTitle('On call with ' + _pName);
      _startTimer();
      // Record the connected call once, from the caller's side only.
      if (_isCaller && !_callLogId) {
        _insertCallLog('answered', 0).then(function (id) { _callLogId = id; });
      }
      setCallState({
        active: true, coupleId: _coupleId, myId: _myId,
        pName: _pName, pInitial: _pInitial, myName: _myName, myInitial: _myInitial,
        roomName: roomName
      });
    });

    _room.on(LK.RoomEvent.ParticipantDisconnected, function() {
      // Partner may be navigating to another page — give them 15 s to reconnect
      _stopTimer();
      _setTitle(_pName + ' reconnecting...');
      if (_reconnectTimer) clearTimeout(_reconnectTimer);
      _reconnectTimer = setTimeout(function() {
        _reconnectTimer = null;
        _cleanup(true, false);
      }, 15000);
    });

    _room.on(LK.RoomEvent.Disconnected, function() {
      // If we're navigating, preserve sessionStorage so the new page can rejoin
      if (_pageUnloading) return;
      // If _room is already null, _cleanup() was the caller — avoid re-entry
      if (!_room) return;
      _cleanup(true, false);
    });

    // ── Connect + publish local tracks ──────────────────────────────────────
    try {
      await _room.connect(data.url, data.token);
    } catch (err) {
      var msg = String((err && err.message) || err);
      console.error('[LoveCall] signal connection to ' + data.url + ' failed:', err);
      if (/websocket|could not establish|signal/i.test(msg)) {
        throw new Error('Call server unreachable — check that the LiveKit server behind ' + data.url + ' is up and LIVEKIT_URL is correct');
      }
      throw err;
    }

    // Unblock audio playback (browser autoplay policy requires a user-gesture ancestor)
    try { await _room.startAudio(); } catch(_) {}

    // Publish camera + mic
    await _room.localParticipant.enableCameraAndMicrophone();

    // Attach local video to PIP
    var localVideoTrack = _room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
    if (localVideoTrack && localVideoTrack.track) {
      var lv = _el('lf-local-vid');
      if (lv) localVideoTrack.track.attach(lv);
    }

    return _room;
  }

  // ─── SIGNALING (ring notification via Supabase Realtime) ─────────────────────
  function _openSig(url, key, token, coupleId) {
    var need = 'realtime:call:' + coupleId;
    // Reuse live channel for the same couple — don't tear down mid-ring
    if (_sigCh && !_sigCh._closed && _sigCh._channel === need) return;
    if (_sigCh) { _sigCh.close(); _sigCh = null; }
    _sigCh = new RealtimeChannel(url, key, token, 'call:' + coupleId);
    _sigCh
      .on('ring',     _onRing)
      .on('hangup',   _onHangup)
      .on('declined', _onDeclined);
    _sigCh.connect();
  }

  // Open signal channel with retry until couple_id is available in localStorage
  function _tryOpenSig() {
    clearTimeout(_sigRetry); _sigRetry = null;
    var creds = _creds();
    if (!creds || !creds.token) return;
    if (!creds.coupleId) {
      _sigRetry = setTimeout(_tryOpenSig, 2000);
      return;
    }
    if (!_myId)     _myId     = creds.userId;
    if (!_coupleId) _coupleId = creds.coupleId;
    _openSig(creds.url, creds.key, creds.token, creds.coupleId);
  }

  // Ring with retry every 3 s until partner joins (max ~45 s)
  function _startRinging(roomName) {
    _clearRingTimer();
    var payload = { from: _myId, to: null, roomName: roomName,
                    callerName: _myName, callerInitial: _myInitial };
    function _doRing() { if (_sigCh) _sigCh.broadcast('ring', payload); }
    _doRing();
    var attempts = 0;
    _ringTimer = setInterval(function() {
      if (!_room) { _clearRingTimer(); return; }
      if (++attempts > 14) { _clearRingTimer(); return; } // ~45 s
      _doRing();
    }, 3000);
  }

  function _clearRingTimer() {
    clearInterval(_ringTimer); _ringTimer = null;
  }

  // Callee receives a ring notification with the room name to join
  function _onRing(p) {
    if (p.from === _myId) return;
    if (p.to && p.to !== _myId) return;
    // Already in a call — auto-ignore
    if (_room && _room.state === 'connected') return;

    _pendRing = p;
    var inc = _el('lf-inc-overlay');
    if (inc) {
      var av = _el('lf-inc-av'); if (av) av.textContent = p.callerInitial || '?';
      var nm = _el('lf-inc-name'); if (nm) nm.textContent = (p.callerName || 'Someone') + ' is calling';
      inc.classList.add('lf-visible');
    }
    _barMode('incoming');
    _setTitle((p.callerName || 'Someone') + ' is calling...');
    _updateVideoPlaceholder();
  }

  async function _acceptIncoming() {
    if (!_pendRing) return;
    var p = _pendRing; _pendRing = null;
    // We're answering, not initiating — the caller owns the history row.
    _isCaller = false; _callLogId = null; _outcomeLogged = false;
    var inc = _el('lf-inc-overlay'); if (inc) inc.classList.remove('lf-visible');

    var creds = _creds(); if (!creds) return;
    _myId     = creds.userId;
    _coupleId = creds.coupleId;
    _pName    = p.callerName    || 'My Love';
    _pInitial = p.callerInitial || (_pName[0] || 'M').toUpperCase();

    _updateVideoPlaceholder();
    _showVideo();
    _barMode('');
    _setTitle('Connecting...');

    _loadSDK(async function() {
      try {
        await _joinRoom(p.roomName, _myId);
      } catch(err) {
        console.error('[LoveCall] join failed', err);
        _setTitle(err && err.message ? err.message : 'Call failed');
        setTimeout(function(){ _cleanup(false); }, 5000);
      }
    });
  }

  function _onHangup(p) {
    if (p && p.from === _myId) return;
    _cleanup(true);
  }

  function _onDeclined(p) {
    if (p && p.from === _myId) return;
    if (_isCaller && !_outcomeLogged) { _outcomeLogged = true; _insertCallLog('declined', 0); }
    _setTitle(_pName + ' declined');
    setTimeout(function(){ _cleanup(false); }, 2000);
  }

  // ─── CALL HISTORY LOGGING (Supabase call_logs) ───────────────────────────────
  // Only the caller writes a row, so every call produces exactly one history
  // entry that both partners can read (RLS scopes rows to the couple).
  function _insertCallLog(status, durationSec) {
    var creds = _creds();
    if (!creds || !creds.token || !_coupleId || !_myId) return Promise.resolve(null);
    var nowIso = new Date().toISOString();
    return fetch(creds.url + '/rest/v1/call_logs', {
      method: 'POST',
      headers: {
        apikey: creds.key,
        Authorization: 'Bearer ' + creds.token,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        couple_id:        _coupleId,
        caller_id:        _myId,
        status:           status,
        duration_seconds: durationSec || 0,
        started_at:       nowIso,
        ended_at:         status === 'answered' ? null : nowIso
      })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) { return (rows && rows[0] && rows[0].id) || null; })
      .catch(function () { return null; });
  }

  function _updateCallLog(id, durationSec) {
    var creds = _creds();
    if (!creds || !creds.token || !id) return;
    fetch(creds.url + '/rest/v1/call_logs?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: {
        apikey: creds.key,
        Authorization: 'Bearer ' + creds.token,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ ended_at: new Date().toISOString(), duration_seconds: durationSec || 0 })
    }).catch(function () {});
  }

  // Records the final outcome of a call. Called from _cleanup; no-ops on the
  // callee side and after the outcome has already been written.
  function _logCallEnd() {
    if (!_isCaller) return;
    if (_callLogId) {
      _updateCallLog(_callLogId, _sec);
    } else if (!_outcomeLogged) {
      // Caller ended before the partner ever connected → unanswered.
      _outcomeLogged = true;
      _insertCallLog('missed', 0);
    }
  }

  // ─── CLEANUP ──────────────────────────────────────────────────────────────────
  function _cleanup(notify, keepState) {
    _logCallEnd();
    _stopTimer();
    _clearRingTimer();
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    var room = _room;
    _room = null;          // null first so Disconnected handler doesn't re-enter
    if (room) {
      try { room.disconnect(); } catch(_){}
    }
    _hasRemoteVideo = false;
    _sharingScreen = false; _screenTrack = null;
    _stopShareOverlay();
    _hideVideo();
    _isCaller = false; _callLogId = null; _outcomeLogged = false;
    if (!keepState) setCallState(null);
    if (notify) {
      _setTitle('Call ended');
      setTimeout(function(){ _hideBar(); _minimized = false; }, 2000);
    } else {
      _hideBar();
      _minimized = false;
    }
  }

  // ─── PUBLIC: START CALL ───────────────────────────────────────────────────────
  async function startCall(partnerName, coupleId, myUserId, myName, myInitial, wantVideo) {
    var creds = _creds(); if (!creds || !creds.token) return;

    // This side initiated → it owns the call-history row for this call.
    _isCaller = true; _callLogId = null; _outcomeLogged = false;

    _myId      = myUserId   || creds.userId;
    _coupleId  = coupleId   || creds.coupleId;
    _pName     = partnerName || 'My Love';
    _pInitial  = (_pName[0]  || 'M').toUpperCase();
    _myName    = myName      || 'Me';
    _myInitial = (myInitial  || _myName[0] || 'M').toUpperCase();

    // Room name = coupleId so both users always land in the same room
    var roomName = 'couple-' + _coupleId;

    _barMode('calling');
    _setTitle('Calling ' + _pName + '...', '');
    _updateVideoPlaceholder();
    _showVideo();

    _openSig(creds.url, creds.key, creds.token, _coupleId);

    _loadSDK(async function() {
      try {
        await _joinRoom(roomName, _myId);

        // Ring partner — retries every 3 s automatically
        _startRinging(roomName);

        // No-answer timeout: 45 s
        setTimeout(function(){
          if (!_room) return;
          var hasPartner = _room.remoteParticipants && _room.remoteParticipants.size > 0;
          if (!hasPartner) {
            _clearRingTimer();
            if (_isCaller && !_callLogId && !_outcomeLogged) {
              _outcomeLogged = true;
              _insertCallLog('missed', 0);
            }
            _setTitle('No answer');
            setTimeout(function(){ _cleanup(false); }, 2000);
          }
        }, 45000);

      } catch(err) {
        console.error('[LoveCall] startCall failed', err);
        _setTitle(err && err.message ? err.message : 'Call failed');
        setTimeout(function(){ _cleanup(false); }, 5000);
      }
    });
  }

  // ─── PUBLIC: END CALL ─────────────────────────────────────────────────────────
  function endCall() {
    if (_sigCh) _sigCh.broadcast('hangup', { from: _myId });
    _cleanup(false, false);
  }

  // ─── MUTE / CAMERA ───────────────────────────────────────────────────────────
  function toggleMute() {
    if (!_room) return;
    _muted = !_muted;
    _room.localParticipant.setMicrophoneEnabled(!_muted);
    var bm = _el('lf-cb-mute');  if (bm) { bm.classList.toggle('lf-muted', _muted); bm.setAttribute('aria-pressed', String(_muted)); bm.setAttribute('aria-label', _muted ? 'Unmute microphone' : 'Mute microphone'); }
    var vm = _el('lf-vid-mute'); if (vm) { vm.classList.toggle('lf-muted', _muted); vm.setAttribute('aria-pressed', String(_muted)); vm.setAttribute('aria-label', _muted ? 'Unmute microphone' : 'Mute microphone'); }
  }

  function toggleCamera() {
    if (!_room) return;
    _camOff = !_camOff;
    _room.localParticipant.setCameraEnabled(!_camOff);
    var vc = _el('lf-vid-cam'); if (vc) { vc.classList.toggle('lf-muted', _camOff); vc.setAttribute('aria-pressed', String(!_camOff)); }
    var my = _el('lf-my-video'); if (my) my.style.opacity = _camOff ? '0' : '1';
  }

  // ─── FULLSCREEN ───────────────────────────────────────────────────────────────
  function _toggleFullscreen() {
    var wrap = _el('lf-video-wrap');
    if (!wrap) return;
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      var exitFs = document.exitFullscreen || document.webkitExitFullscreen;
      if (exitFs) exitFs.call(document);
    } else {
      var reqFs = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
      if (reqFs) reqFs.call(wrap);
    }
  }

  function _onFullscreenChange() {
    var fsEl  = document.fullscreenElement || document.webkitFullscreenElement;
    var btn   = _el('lf-vid-fs');
    var wrap  = _el('lf-video-wrap');
    if (!btn || !wrap) return;
    if (fsEl === wrap) {
      // In fullscreen — override fixed sizing so it fills the screen
      wrap.style.width = '100%';
      wrap.style.height = '100%';
      wrap.style.top = '0';
      wrap.style.left = '0';
      wrap.style.right = '0';
      wrap.style.bottom = '0';
      wrap.style.borderRadius = '0';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';
      btn.title = 'Exit fullscreen';
    } else {
      // Restore normal size
      wrap.style.width = '';
      wrap.style.height = '';
      wrap.style.top = '';
      wrap.style.left = '';
      wrap.style.right = '16px';
      wrap.style.bottom = '66px';
      wrap.style.borderRadius = '';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
      btn.title = 'Fullscreen';
    }
  }

  // ─── RESIZABLE VIDEO CARD ────────────────────────────────────────────────────
  function _makeResizable(wrap, handle) {
    var MIN_W = 200, MIN_H = 200;
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var startX  = e.clientX, startY  = e.clientY;
      var startW  = wrap.offsetWidth,  startH  = wrap.offsetHeight;
      function onMove(e) {
        var w = Math.max(MIN_W, startW + (e.clientX - startX));
        var h = Math.max(MIN_H, startH + (e.clientY - startY));
        wrap.style.width  = w + 'px';
        wrap.style.height = h + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      var startX = t.clientX, startY = t.clientY;
      var startW = wrap.offsetWidth,  startH = wrap.offsetHeight;
      function onMove(e) {
        e.preventDefault();
        var t = e.touches[0];
        var w = Math.max(MIN_W, startW + (t.clientX - startX));
        var h = Math.max(MIN_H, startH + (t.clientY - startY));
        wrap.style.width  = w + 'px';
        wrap.style.height = h + 'px';
      }
      function onUp() {
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
      }
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    }, { passive: true });
  }

  // ─── SCREEN SHARE ────────────────────────────────────────────────────────────
  var _sharingScreen = false;
  var _screenTrack   = null;

  async function toggleScreenShare() {
    if (!_room) return;
    var LK = window.LivekitClient;
    if (!LK) return;

    if (_sharingScreen) {
      _sharingScreen = false;
      try { await _room.localParticipant.setScreenShareEnabled(false); } catch(_) {}
      if (_screenTrack) { try { _screenTrack.stop(); } catch(_) {} _screenTrack = null; }
      var btn = _el('lf-vid-share'); if (btn) btn.classList.remove('lf-sharing');
    } else {
      try {
        await _room.localParticipant.setScreenShareEnabled(true);
        _sharingScreen = true;
        var btn = _el('lf-vid-share'); if (btn) btn.classList.add('lf-sharing');
        // Mirror local screen into the share overlay for preview
        var localScreenPub = _room.localParticipant.getTrackPublication(LK.Track.Source.ScreenShare);
        if (localScreenPub && localScreenPub.track) {
          var shareVid = _el('lf-share-vid');
          if (shareVid) localScreenPub.track.attach(shareVid);
          var pipVid = _el('lf-share-pip-vid');
          var remoteVid = _el('lf-remote-vid');
          if (pipVid && remoteVid) pipVid.srcObject = remoteVid.srcObject;
          var overlay = _el('lf-share-overlay');
          var lbl     = _el('lf-share-label');
          if (overlay) overlay.classList.add('lf-visible');
          if (lbl) lbl.textContent = '🖥 You are sharing your screen';
          localScreenPub.track.on('ended', function () {
            _stopShareOverlay();
            _sharingScreen = false;
            if (btn) btn.classList.remove('lf-sharing');
          });
        }
      } catch(err) {
        _sharingScreen = false;
        console.error('[LoveCall] screen share failed', err);
      }
    }
  }

  function _stopShareOverlay() {
    var overlay = _el('lf-share-overlay');
    if (overlay) overlay.classList.remove('lf-visible');
    var sv = _el('lf-share-vid');
    if (sv) { sv.srcObject = null; }
  }

  function _showRemoteScreenShare(track) {
    var shareVid = _el('lf-share-vid');
    if (shareVid) track.attach(shareVid);
    var pipVid  = _el('lf-share-pip-vid');
    var remoteVid = _el('lf-remote-vid');
    if (pipVid && remoteVid) pipVid.srcObject = remoteVid.srcObject;
    var overlay = _el('lf-share-overlay');
    var lbl     = _el('lf-share-label');
    if (overlay) overlay.classList.add('lf-visible');
    if (lbl) lbl.textContent = '📺 ' + _pName + ' is sharing their screen';
  }

  // ─── DRAGGABLE VIDEO CARD (identical to original) ────────────────────────────
  function _makeDraggable(wrap, handle) {
    var startX, startY, origLeft, origTop;
    function onMove(cx, cy) {
      wrap.style.left   = (origLeft + cx - startX) + 'px';
      wrap.style.top    = (origTop  + cy - startY) + 'px';
      wrap.style.right  = 'auto';
      wrap.style.bottom = 'auto';
    }
    handle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      var rect = wrap.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      origLeft = rect.left; origTop = rect.top;
      function mm(e) { onMove(e.clientX, e.clientY); }
      function mu()  { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
    handle.addEventListener('touchstart', function(e) {
      var t = e.touches[0];
      var rect = wrap.getBoundingClientRect();
      startX = t.clientX; startY = t.clientY;
      origLeft = rect.left; origTop = rect.top;
      function tm(e) { e.preventDefault(); var t = e.touches[0]; onMove(t.clientX, t.clientY); }
      function tu()  { document.removeEventListener('touchmove', tm); document.removeEventListener('touchend', tu); }
      document.addEventListener('touchmove', tm, { passive: false });
      document.addEventListener('touchend', tu);
    }, { passive: true });
  }

  // ─── VIDEO SYNC (unchanged — still uses Supabase Realtime) ───────────────────
  function initVideoSync(coupleId, userId) {
    var creds = _creds(); if (!creds) return;
    var cid = coupleId || creds.coupleId;
    var uid = userId   || creds.userId;
    if (_vsyncCh) { _vsyncCh.close(); _vsyncCh = null; }
    _vsyncCh = new RealtimeChannel(creds.url, creds.key, creds.token, 'vsync:' + cid);
    _vsyncCh
      .on('play',  function(p){ if(p.from!==uid) document.dispatchEvent(new CustomEvent('lf:vsync:play',  {detail:p})); })
      .on('pause', function(p){ if(p.from!==uid) document.dispatchEvent(new CustomEvent('lf:vsync:pause', {detail:p})); })
      .on('seek',  function(p){ if(p.from!==uid) document.dispatchEvent(new CustomEvent('lf:vsync:seek',  {detail:p})); });
    _vsyncCh.connect();
    _myId = uid;
  }

  function vsyncPlay(t)  { if (_vsyncCh) _vsyncCh.broadcast('play',  { from:_myId, t:t }); }
  function vsyncPause(t) { if (_vsyncCh) _vsyncCh.broadcast('pause', { from:_myId, t:t }); }
  function vsyncSeek(t)  { if (_vsyncCh) _vsyncCh.broadcast('seek',  { from:_myId, t:t }); }

  // ─── PAGE INIT ────────────────────────────────────────────────────────────────
  function init() {
    injectUI();

    // Preserve sessionStorage across same-tab navigation so the new page can rejoin
    window.addEventListener('pagehide', function() { _pageUnloading = true; });

    // Re-enable audio if browser blocked autoplay on the reconnected page
    var bar = document.getElementById('lf-call-bar');
    if (bar) bar.addEventListener('click', function() {
      if (_room) try { _room.startAudio(); } catch(_) {}
    }, { once: false });

    // Incoming overlay buttons
    var accBtn = _el('lf-inc-acc');
    if (accBtn) accBtn.addEventListener('click', _acceptIncoming);

    var decBtn = _el('lf-inc-dec');
    if (decBtn) decBtn.addEventListener('click', function () {
      if (_sigCh && _pendRing) _sigCh.broadcast('declined', { from: _myId, to: _pendRing.from });
      _pendRing = null;
      var inc = _el('lf-inc-overlay'); if (inc) inc.classList.remove('lf-visible');
      _hideBar();
    });

    // Bar buttons
    var hangBtn    = _el('lf-cb-hang');    if (hangBtn)    hangBtn.addEventListener('click',    endCall);
    var muteBtn    = _el('lf-cb-mute');    if (muteBtn)    muteBtn.addEventListener('click',    toggleMute);
    var barAccBtn  = _el('lf-cb-acc');     if (barAccBtn)  barAccBtn.addEventListener('click',  _acceptIncoming);
    var restoreBtn = _el('lf-cb-restore'); if (restoreBtn) restoreBtn.addEventListener('click', _showVideo);

    // In-video buttons
    var vHang  = _el('lf-vid-hang');   if (vHang)  vHang.addEventListener('click',  endCall);
    var vMute  = _el('lf-vid-mute');   if (vMute)  vMute.addEventListener('click',  toggleMute);
    var vCam   = _el('lf-vid-cam');    if (vCam)   vCam.addEventListener('click',   toggleCamera);
    var vMin   = _el('lf-vid-min');    if (vMin)   vMin.addEventListener('click',   _hideVideo);
    var vFs    = _el('lf-vid-fs');     if (vFs)    vFs.addEventListener('click',    _toggleFullscreen);
    var vShare = _el('lf-vid-share');  if (vShare) vShare.addEventListener('click', toggleScreenShare);

    // Share overlay close button
    var shareClose = _el('lf-share-close');
    if (shareClose) shareClose.addEventListener('click', function () {
      _stopShareOverlay();
      if (_sharingScreen) { toggleScreenShare(); }
    });

    // Fullscreen change listeners
    document.addEventListener('fullscreenchange',       _onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', _onFullscreenChange);

    // Draggable
    var vWrap   = _el('lf-video-wrap');
    var vHandle = _el('lf-vid-drag');
    if (vWrap && vHandle) _makeDraggable(vWrap, vHandle);

    // Resizable
    var vResize = _el('lf-vid-resize');
    if (vWrap && vResize) _makeResizable(vWrap, vResize);

    // Restore / listen for incoming
    var saved  = getCallState();
    var creds  = _creds();
    if (!creds || !creds.token) return;

    _myId     = saved ? (saved.myId     || creds.userId)   : creds.userId;
    _coupleId = saved ? (saved.coupleId || creds.coupleId) : creds.coupleId;

    if (saved && saved.pName)  { _pName = saved.pName;  _pInitial = saved.pInitial  || _pName[0].toUpperCase(); }
    if (saved && saved.myName) { _myName = saved.myName; _myInitial = saved.myInitial || _myName[0].toUpperCase(); }

    // Always open signaling so we can receive incoming rings.
    // _tryOpenSig retries if couple_id isn't in localStorage yet.
    _tryOpenSig();

    // Reconnect if we were on a call when page navigated
    if (saved && saved.active && saved.roomName) {
      _barMode('');
      _setTitle('On call with ' + _pName);
      _updateVideoPlaceholder();
      _showVideo();
      _loadSDK(async function() {
        try {
          await _joinRoom(saved.roomName, _myId);
          _startTimer();
        } catch(err) {
          _cleanup(false);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }

  // ─── EXPORTS (identical API surface — nothing else in LoveFlix needs to change)
  global.LoveFlix      = global.LoveFlix || {};
  global.LoveFlix.Call = {
    start:             startCall,
    end:               endCall,
    toggleMute:        toggleMute,
    toggleCamera:      toggleCamera,
    toggleScreenShare: toggleScreenShare,
    initVideoSync:     initVideoSync,
    vsyncPlay:         vsyncPlay,
    vsyncPause:        vsyncPause,
    vsyncSeek:         vsyncSeek
  };

})(window);
