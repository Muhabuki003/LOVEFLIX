// loveflix-call.js — Persistent WebRTC video/audio calling for LOVEFLIX
// Injects a floating call bar that follows across all pages via sessionStorage reconnect.
(function (global) {
  'use strict';

  var STUN = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  // ─── SUPABASE REALTIME MINI-CLIENT ───────────────────────────────────────────
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

  RealtimeChannel.prototype.on = function (event, fn) { this._handlers[event] = fn; return this; };

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

  RealtimeChannel.prototype.close = function () {
    this._closed = true;
    clearInterval(this._hbTimer);
    clearTimeout(this._retTimer);
    if (this._ws) try { this._ws.close(); } catch(_){}
  };

  RealtimeChannel.prototype._send = function (msg) {
    if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(msg));
  };

  RealtimeChannel.prototype._nextRef = function () { return String(++this._ref); };

  // ─── SESSION STATE ────────────────────────────────────────────────────────────
  var SS_KEY = 'loveflix_call';
  function getCallState()  { try { return JSON.parse(sessionStorage.getItem(SS_KEY)||'null'); } catch(_){ return null; } }
  function setCallState(s) { if(s) sessionStorage.setItem(SS_KEY,JSON.stringify(s)); else sessionStorage.removeItem(SS_KEY); }

  // ─── INJECTED HTML ────────────────────────────────────────────────────────────
  var BAR_ID = 'lf-call-bar';

  var BAR_CSS = '<style id="lf-call-css">'
    + '#lf-call-bar{position:fixed;bottom:0;left:0;right:0;z-index:9999;'
    + 'background:linear-gradient(135deg,#120606 0%,#1e0a0a 100%);'
    + 'border-top:1px solid rgba(220,38,38,.35);'
    + 'display:none;align-items:center;gap:12px;padding:10px 18px;'
    + 'box-shadow:0 -4px 30px rgba(0,0,0,.7);font-family:Inter,sans-serif;}'
    + '#lf-call-bar.lf-active{display:flex;}'
    + '.lf-cb-pulse{width:10px;height:10px;border-radius:50%;background:#22c55e;flex-shrink:0;'
    + 'box-shadow:0 0 0 0 rgba(34,197,94,.7);animation:lf-ring 1.6s ease-out infinite;}'
    + '#lf-call-bar.lf-calling .lf-cb-pulse{background:#eab308;animation:lf-ring-y 1.6s ease-out infinite;}'
    + '#lf-call-bar.lf-incoming .lf-cb-pulse{background:#3b82f6;animation:lf-ring-b 1.6s ease-out infinite;}'
    + '@keyframes lf-ring  {0%{box-shadow:0 0 0 0 rgba(34,197,94,.7)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}'
    + '@keyframes lf-ring-y{0%{box-shadow:0 0 0 0 rgba(234,179,8,.7)} 70%{box-shadow:0 0 0 8px rgba(234,179,8,0)} 100%{box-shadow:0 0 0 0 rgba(234,179,8,0)}}'
    + '@keyframes lf-ring-b{0%{box-shadow:0 0 0 0 rgba(59,130,246,.7)}70%{box-shadow:0 0 0 8px rgba(59,130,246,0)}100%{box-shadow:0 0 0 0 rgba(59,130,246,0)}}'
    + '.lf-cb-info{flex:1;min-width:0;}'
    + '.lf-cb-title{font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.lf-cb-sub{font-size:11px;color:rgba(255,255,255,.45);margin-top:2px;}'
    + '.lf-cb-actions{display:flex;gap:8px;flex-shrink:0;}'
    + '.lf-cb-btn{width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;'
    + 'display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(255,255,255,.1);color:#fff;transition:background .2s;}'
    + '.lf-cb-btn:hover{background:rgba(255,255,255,.2);}'
    + '.lf-cb-btn.lf-danger{background:#dc2626;}'
    + '.lf-cb-btn.lf-danger:hover{background:#b91c1c;}'
    + '.lf-cb-btn.lf-accept{background:#16a34a;}'
    + '.lf-cb-btn.lf-accept:hover{background:#15803d;}'
    + '.lf-cb-btn.lf-muted{background:rgba(220,38,38,.45);}'
    + '#lf-video-wrap{position:fixed;bottom:58px;right:16px;z-index:9998;'
    + 'width:220px;height:165px;border-radius:12px;overflow:hidden;'
    + 'box-shadow:0 4px 28px rgba(0,0,0,.85);background:#000;display:none;'
    + 'border:2px solid rgba(220,38,38,.4);cursor:move;}'
    + '#lf-video-wrap.lf-visible{display:block;}'
    + '#lf-video-wrap video{width:100%;height:100%;object-fit:cover;}'
    + '#lf-my-video{position:absolute;bottom:8px;right:8px;'
    + 'width:64px;height:48px;border-radius:7px;overflow:hidden;'
    + 'border:1.5px solid rgba(255,255,255,.3);background:#111;}'
    + '#lf-my-video video{width:100%;height:100%;object-fit:cover;}'
    + '#lf-inc-overlay{position:fixed;top:0;left:0;right:0;bottom:0;'
    + 'background:rgba(0,0,0,.88);z-index:10000;display:none;'
    + 'align-items:center;justify-content:center;flex-direction:column;gap:16px;}'
    + '#lf-inc-overlay.lf-visible{display:flex;}'
    + '#lf-inc-av{width:84px;height:84px;border-radius:50%;'
    + 'background:linear-gradient(135deg,#dc2626,#7f1d1d);'
    + 'display:flex;align-items:center;justify-content:center;'
    + 'font-size:34px;font-weight:700;color:#fff;font-family:"Bebas Neue",sans-serif;'
    + 'animation:lf-inc-ring 1.4s ease-out infinite;}'
    + '@keyframes lf-inc-ring{0%{box-shadow:0 0 0 0 rgba(220,38,38,.7)}70%{box-shadow:0 0 0 22px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}'
    + '#lf-inc-name{font-size:30px;font-weight:700;color:#fff;font-family:"Bebas Neue",sans-serif;letter-spacing:1.5px;}'
    + '#lf-inc-sub{font-size:13px;color:rgba(255,255,255,.45);}'
    + '.lf-inc-actions{display:flex;gap:36px;margin-top:12px;}'
    + '.lf-inc-btn{width:68px;height:68px;border-radius:50%;border:none;cursor:pointer;'
    + 'display:flex;align-items:center;justify-content:center;color:#fff;transition:transform .15s;}'
    + '.lf-inc-btn:hover{transform:scale(1.08);}'
    + '.lf-inc-accept{background:#16a34a;}'
    + '.lf-inc-decline{background:#dc2626;}'
    + '</style>';

  var BAR_HTML = '<div id="lf-inc-overlay">'
    + '<div id="lf-inc-av">M</div>'
    + '<div id="lf-inc-name">Incoming Call</div>'
    + '<div id="lf-inc-sub">LoveConnect · Encrypted</div>'
    + '<div class="lf-inc-actions">'
    + '<button class="lf-inc-btn lf-inc-decline" id="lf-inc-dec" title="Decline">'
    + '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 01-1.41-.04L.29 13.08a1 1 0 010-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 010 1.41l-2.48 2.45a1 1 0 01-1.41.04 11.66 11.66 0 00-2.66-1.85c-.33-.16-.56-.51-.56-.9v-3.1A15.7 15.7 0 0012 9z" transform="rotate(135 12 12)"/></svg>'
    + '</button>'
    + '<button class="lf-inc-btn lf-inc-accept" id="lf-inc-acc" title="Accept">'
    + '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M20 15.5c-1.25 0-2.45-.2-3.57-.57a1 1 0 00-1.02.24l-2.2 2.2a15.04 15.04 0 01-6.59-6.59l2.2-2.21a1 1 0 00.25-1.01A11.36 11.36 0 018.5 4a1 1 0 00-1-1H4a1 1 0 00-1 1c0 9.39 7.61 17 17 17a1 1 0 001-1v-3.5a1 1 0 00-1-1z"/></svg>'
    + '</button>'
    + '</div></div>'
    + '<div id="lf-video-wrap">'
    + '<video id="lf-remote-vid" autoplay playsinline></video>'
    + '<div id="lf-my-video"><video id="lf-local-vid" autoplay playsinline muted></video></div>'
    + '</div>'
    + '<div class="lf-cb-pulse"></div>'
    + '<div class="lf-cb-info"><div class="lf-cb-title" id="lf-cb-title">On call</div>'
    + '<div class="lf-cb-sub" id="lf-cb-sub">00:00</div></div>'
    + '<div class="lf-cb-actions">'
    + '<button class="lf-cb-btn" id="lf-cb-mute" title="Mute">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3zm5.91-3a.9.9 0 00-.91.91A4.96 4.96 0 0112 17a4.96 4.96 0 01-5-5.09.91.91 0 10-1.82 0A6.78 6.78 0 0011 18.71V21a1 1 0 002 0v-2.29a6.78 6.78 0 005.82-6.8.91.91 0 00-.91-.91z"/></svg>'
    + '</button>'
    + '<button class="lf-cb-btn" id="lf-cb-cam" title="Toggle camera">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg>'
    + '</button>'
    + '<button class="lf-cb-btn lf-danger" id="lf-cb-hang" title="End call">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 01-1.41-.04L.29 13.08a1 1 0 010-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 010 1.41l-2.48 2.45a1 1 0 01-1.41.04 11.66 11.66 0 00-2.66-1.85c-.33-.16-.56-.51-.56-.9v-3.1A15.7 15.7 0 0012 9z" transform="rotate(135 12 12)"/></svg>'
    + '</button>'
    + '</div>';

  function injectBar() {
    if (document.getElementById(BAR_ID)) return;
    var wrap = document.createElement('div');
    wrap.id = BAR_ID;
    document.head.insertAdjacentHTML('beforeend', BAR_CSS);
    wrap.innerHTML = BAR_HTML;
    document.body.appendChild(wrap);
  }

  // ─── INTERNAL STATE ───────────────────────────────────────────────────────────
  var _pc        = null;
  var _local     = null;   // MediaStream
  var _sigCh     = null;   // signaling RealtimeChannel
  var _vsyncCh   = null;   // video-sync RealtimeChannel
  var _timer     = null;
  var _sec       = 0;
  var _muted     = false;
  var _camOff    = false;
  var _myId      = null;
  var _coupleId  = null;
  var _pName     = 'My Love';
  var _pInitial  = 'M';
  var _myName    = 'Me';
  var _myInitial = 'M';
  var _pendOffer = null;   // stored incoming offer before accept

  function _lf() { return typeof LoveFlix !== 'undefined' ? LoveFlix : null; }

  function _creds() {
    var lf = _lf();
    if (!lf) return null;
    return { url: lf.SUPABASE_URL, key: lf.SUPABASE_ANON_KEY,
             token: lf.getToken(), userId: lf.getUserId(), coupleId: lf.getCoupleId() };
  }

  function _el(id) { return document.getElementById(id); }

  function _barMode(mode) {
    var b = _el(BAR_ID);
    if (!b) return;
    b.className = 'lf-active' + (mode ? ' lf-' + mode : '');
  }

  function _hideBar() { var b = _el(BAR_ID); if (b) b.className = ''; }

  function _setTitle(t) { var el = _el('lf-cb-title'); if (el) el.textContent = t; }

  function _startTimer() {
    _sec = 0;
    clearInterval(_timer);
    _timer = setInterval(function () {
      _sec++;
      var el = _el('lf-cb-sub');
      if (el) el.textContent = pad(_sec);
    }, 1000);
  }

  function pad(s) {
    var m = Math.floor(s/60), sec = s%60;
    return (m<10?'0':'')+m+':'+(sec<10?'0':'')+sec;
  }

  function _stopTimer() { clearInterval(_timer); _timer = null; }

  // ─── WebRTC ────────────────────────────────────────────────────────────────────
  function _makePC() {
    _pc = new RTCPeerConnection({ iceServers: STUN });

    _pc.onicecandidate = function (e) {
      if (e.candidate && _sigCh)
        _sigCh.broadcast('ice', { c: e.candidate.toJSON(), from: _myId });
    };

    _pc.ontrack = function (e) {
      var vid = _el('lf-remote-vid');
      if (vid && e.streams[0]) {
        vid.srcObject = e.streams[0];
        var wrap = _el('lf-video-wrap');
        if (wrap) wrap.classList.add('lf-visible');
      }
    };

    _pc.onconnectionstatechange = function () {
      var st = _pc && _pc.connectionState;
      if (st === 'connected') {
        _barMode('');
        _setTitle('On call with ' + _pName);
        _startTimer();
        setCallState({ active:true, coupleId:_coupleId, myId:_myId,
                       pName:_pName, pInitial:_pInitial, myName:_myName, myInitial:_myInitial });
      } else if (st === 'failed' || st === 'closed') {
        _cleanup(true);
      }
    };
  }

  function _addTracks() {
    if (!_pc || !_local) return;
    _local.getTracks().forEach(function(t){ _pc.addTrack(t, _local); });
  }

  async function _getMedia(wantVideo) {
    var constraints = wantVideo ? { audio:true, video:true } : { audio:true, video:false };
    try { _local = await navigator.mediaDevices.getUserMedia(constraints); }
    catch(_) {
      try { _local = await navigator.mediaDevices.getUserMedia({ audio:true, video:false }); }
      catch(__) { _local = null; }
    }
    var lv = _el('lf-local-vid');
    if (lv && _local) lv.srcObject = _local;
  }

  // ─── SIGNALING HANDLERS ───────────────────────────────────────────────────────
  function _openSig(url, key, token, coupleId) {
    if (_sigCh) { _sigCh.close(); _sigCh = null; }
    _sigCh = new RealtimeChannel(url, key, token, 'call:' + coupleId);
    _sigCh
      .on('offer',    _onOffer)
      .on('answer',   _onAnswer)
      .on('ice',      _onIce)
      .on('hangup',   _onHangup)
      .on('declined', _onDeclined)
      .on('reoffer',  _onReOffer);
    _sigCh.connect();
  }

  function _onOffer(p) {
    if (p.to && p.to !== _myId) return;
    // Store offer and show incoming UI
    _pendOffer = p;
    var inc = _el('lf-inc-overlay');
    if (inc) {
      var av = _el('lf-inc-av'); if (av) av.textContent = p.callerInitial || '?';
      var nm = _el('lf-inc-name'); if (nm) nm.textContent = (p.callerName || 'Someone') + ' is calling';
      inc.classList.add('lf-visible');
    }
    _barMode('incoming');
    _setTitle((p.callerName || 'Someone') + ' is calling...');
  }

  async function _acceptIncoming() {
    if (!_pendOffer) return;
    var p = _pendOffer; _pendOffer = null;
    _el('lf-inc-overlay').classList.remove('lf-visible');
    var creds = _creds();
    if (!creds) return;
    _myId     = creds.userId;
    _coupleId = creds.coupleId;
    await _getMedia(true);
    _makePC();
    _addTracks();
    await _pc.setRemoteDescription(new RTCSessionDescription(p.offer));
    var ans = await _pc.createAnswer();
    await _pc.setLocalDescription(ans);
    _sigCh.broadcast('answer', { answer:ans, from:_myId, to:p.from });
    _barMode('');
    _setTitle('Connecting...');
  }

  function _onAnswer(p) {
    if (!_pc || (p.to && p.to !== _myId)) return;
    _pc.setRemoteDescription(new RTCSessionDescription(p.answer)).catch(function(){});
  }

  function _onIce(p) {
    if (!_pc || p.from === _myId) return;
    _pc.addIceCandidate(new RTCIceCandidate(p.c)).catch(function(){});
  }

  function _onHangup() { _cleanup(true); }

  function _onDeclined() {
    _setTitle(_pName + ' declined');
    setTimeout(function(){ _cleanup(false); }, 2000);
  }

  // Re-offer is sent when partner navigates to a new page and needs to reconnect
  async function _onReOffer(p) {
    if (!_pc || p.from === _myId) return;
    // Partner has re-joined; restart our connection too
    _pc.close();
    _makePC();
    _addTracks();
    await _pc.setRemoteDescription(new RTCSessionDescription(p.offer));
    var ans = await _pc.createAnswer();
    await _pc.setLocalDescription(ans);
    _sigCh.broadcast('answer', { answer:ans, from:_myId, to:p.from });
  }

  // ─── CLEANUP ──────────────────────────────────────────────────────────────────
  function _cleanup(notify) {
    _stopTimer();
    if (_pc) { try { _pc.close(); } catch(_){} _pc = null; }
    if (_local) { _local.getTracks().forEach(function(t){ t.stop(); }); _local = null; }
    var wrap = _el('lf-video-wrap');
    if (wrap) wrap.classList.remove('lf-visible');
    setCallState(null);
    if (notify) {
      _setTitle('Call ended'); setTimeout(function(){ _hideBar(); }, 2000);
    } else { _hideBar(); }
  }

  // ─── PUBLIC: START CALL ───────────────────────────────────────────────────────
  async function startCall(partnerName, coupleId, myUserId, myName, myInitial, wantVideo) {
    var creds = _creds();
    if (!creds || !creds.token) return;
    _myId      = myUserId  || creds.userId;
    _coupleId  = coupleId  || creds.coupleId;
    _pName     = partnerName || 'My Love';
    _pInitial  = (_pName[0] || 'M').toUpperCase();
    _myName    = myName    || 'Me';
    _myInitial = (myInitial || _myName[0] || 'M').toUpperCase();

    injectBar();
    _barMode('calling');
    _setTitle('Calling ' + _pName + '...');

    _openSig(creds.url, creds.key, creds.token, _coupleId);

    await _getMedia(wantVideo !== false);
    _makePC();
    _addTracks();

    var offer = await _pc.createOffer();
    await _pc.setLocalDescription(offer);

    // Short wait for WS join ack
    await new Promise(function(r){ setTimeout(r, 700); });
    _sigCh.broadcast('offer', {
      offer: offer, from: _myId, to: null,
      callerName: _myName, callerInitial: _myInitial
    });

    // No-answer timeout
    setTimeout(function(){
      if (_pc && _pc.connectionState !== 'connected') {
        _setTitle('No answer');
        setTimeout(function(){ _cleanup(false); }, 2000);
      }
    }, 45000);
  }

  // ─── PUBLIC: END CALL ─────────────────────────────────────────────────────────
  function endCall() {
    if (_sigCh) _sigCh.broadcast('hangup', { from: _myId });
    _cleanup(false);
  }

  function toggleMute() {
    if (!_local) return;
    _muted = !_muted;
    _local.getAudioTracks().forEach(function(t){ t.enabled = !_muted; });
    var btn = _el('lf-cb-mute'); if (btn) btn.classList.toggle('lf-muted', _muted);
  }

  function toggleCamera() {
    if (!_local) return;
    _camOff = !_camOff;
    _local.getVideoTracks().forEach(function(t){ t.enabled = !_camOff; });
    var btn = _el('lf-cb-cam'); if (btn) btn.classList.toggle('lf-muted', _camOff);
    var wrap = _el('lf-video-wrap'); if (wrap) wrap.classList.toggle('lf-visible', !_camOff);
  }

  // ─── VIDEO SYNC ───────────────────────────────────────────────────────────────
  function initVideoSync(coupleId, userId) {
    var creds = _creds();
    if (!creds) return;
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

  // ─── DRAGGABLE VIDEO PANEL ────────────────────────────────────────────────────
  function _makeDraggable(el) {
    var dx=0, dy=0, sx=0, sy=0;
    el.onmousedown = function(e) {
      e.preventDefault();
      sx=e.clientX; sy=e.clientY;
      document.onmouseup   = function(){ document.onmouseup=null; document.onmousemove=null; };
      document.onmousemove = function(e){
        dx=sx-e.clientX; dy=sy-e.clientY; sx=e.clientX; sy=e.clientY;
        el.style.top  = (el.offsetTop -dy)+'px';
        el.style.left = (el.offsetLeft-dx)+'px';
        el.style.right='auto'; el.style.bottom='auto';
      };
    };
  }

  // ─── PAGE INIT ────────────────────────────────────────────────────────────────
  function init() {
    injectBar();

    // Button wiring
    var hangBtn = _el('lf-cb-hang');   if (hangBtn) hangBtn.addEventListener('click', endCall);
    var muteBtn = _el('lf-cb-mute');   if (muteBtn) muteBtn.addEventListener('click', toggleMute);
    var camBtn  = _el('lf-cb-cam');    if (camBtn)  camBtn.addEventListener('click', toggleCamera);
    var accBtn  = _el('lf-inc-acc');   if (accBtn)  accBtn.addEventListener('click', _acceptIncoming);
    var decBtn  = _el('lf-inc-dec');
    if (decBtn) decBtn.addEventListener('click', function () {
      if (_sigCh && _pendOffer) _sigCh.broadcast('declined', { from:_myId, to:_pendOffer.from });
      _pendOffer = null;
      var inc = _el('lf-inc-overlay'); if (inc) inc.classList.remove('lf-visible');
      _hideBar();
    });

    var vw = _el('lf-video-wrap'); if (vw) _makeDraggable(vw);

    // Restore or listen for incoming calls
    var saved = getCallState();
    var creds = _creds();
    if (!creds || !creds.token) return;

    _myId     = saved ? (saved.myId     || creds.userId)   : creds.userId;
    _coupleId = saved ? (saved.coupleId || creds.coupleId) : creds.coupleId;

    if (saved && saved.pName)     { _pName = saved.pName; _pInitial = saved.pInitial || _pName[0].toUpperCase(); }
    if (saved && saved.myName)    { _myName = saved.myName; _myInitial = saved.myInitial || _myName[0].toUpperCase(); }

    // Always open signaling to receive incoming calls
    if (_coupleId) _openSig(creds.url, creds.key, creds.token, _coupleId);

    // Reconnect if we were in a call before navigating
    if (saved && saved.active) {
      _barMode('');
      _setTitle('On call with ' + _pName);
      // Re-establish WebRTC by sending a new offer (partner will re-answer)
      (async function(){
        await _getMedia(true);
        _makePC();
        _addTracks();
        var offer = await _pc.createOffer();
        await _pc.setLocalDescription(offer);
        await new Promise(function(r){ setTimeout(r, 700); });
        _sigCh.broadcast('reoffer', {
          offer: offer, from: _myId, to: null,
          callerName: _myName, callerInitial: _myInitial
        });
        _startTimer();
      })();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }

  // ─── EXPORTS ──────────────────────────────────────────────────────────────────
  global.LoveFlix        = global.LoveFlix || {};
  global.LoveFlix.Call   = {
    start:          startCall,
    end:            endCall,
    toggleMute:     toggleMute,
    toggleCamera:   toggleCamera,
    initVideoSync:  initVideoSync,
    vsyncPlay:      vsyncPlay,
    vsyncPause:     vsyncPause,
    vsyncSeek:      vsyncSeek
  };

})(window);
