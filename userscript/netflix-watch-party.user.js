// ==UserScript==
// @name         Netflix Watch Party
// @namespace    https://github.com/SachinDabas1
// @version      1.0.0
// @description  Real-time synced Netflix playback + persisted chat between two devices
// @author       Sachin
// @match        https://www.netflix.com/watch/*
// @icon         https://www.netflix.com/favicon.ico
// @grant        none
// @require      https://cdn.socket.io/4.7.5/socket.io.min.js
// @updateURL    __UPDATE_URL__
// @downloadURL  __UPDATE_URL__
// ==/UserScript==

(function () {
  'use strict';

  // Replaced automatically when this file is served from
  // <your-deployed-server>/netflix-watch-party.user.js — no manual editing needed.
  // If you're loading this file directly instead, set your server URL here:
  const SERVER_URL = '__SERVER_URL__';

  const DRIFT_THRESHOLD = 1.5; // seconds of allowed drift before force-correcting
  const HEARTBEAT_MS = 4000;

  let video = null;
  let socket = null;
  let suppress = false;
  let roomCode = localStorage.getItem('nwp_room') || '';
  let username = localStorage.getItem('nwp_name') || '';
  let heartbeatTimer = null;
  let videoListenersAttached = false;

  // ---------- Wait for Netflix's video element (it doesn't exist on load — it's an SPA) ----------
  function waitForVideo(cb) {
    const existing = document.querySelector('video');
    if (existing) return cb(existing);
    const observer = new MutationObserver(() => {
      const v = document.querySelector('video');
      if (v) {
        observer.disconnect();
        cb(v);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- UI ----------
  function buildUI() {
    const host = document.createElement('div');
    host.id = 'nwp-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed;
          top: 70px;
          right: 20px;
          width: 300px;
          max-height: 70vh;
          display: flex;
          flex-direction: column;
          background: rgba(20, 20, 20, 0.95);
          border: 1px solid #333;
          border-radius: 8px;
          font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
          color: #fff;
          z-index: 2147483647;
          box-shadow: 0 8px 24px rgba(0,0,0,0.5);
          overflow: hidden;
        }
        .header {
          background: #000;
          padding: 8px 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: grab;
          border-bottom: 2px solid #E50914;
          user-select: none;
        }
        .header .title { font-size: 13px; font-weight: 700; letter-spacing: 0.4px; }
        .header .title .dot {
          display: inline-block;
          width: 8px; height: 8px;
          border-radius: 50%;
          background: #666;
          margin-right: 6px;
        }
        .header .title .dot.connected { background: #46d369; }
        .header button.min {
          background: none; border: none; color: #999;
          font-size: 16px; cursor: pointer; line-height: 1;
        }
        .body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
        .row { display: flex; gap: 6px; }
        input {
          flex: 1;
          background: #2b2b2b;
          border: 1px solid #444;
          border-radius: 4px;
          color: #fff;
          padding: 7px 8px;
          font-size: 13px;
          box-sizing: border-box;
        }
        input::placeholder { color: #888; }
        button {
          background: #E50914;
          border: none;
          border-radius: 4px;
          color: #fff;
          padding: 7px 12px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        button:hover { background: #f6121d; }
        button:disabled { background: #555; cursor: default; }
        .status { font-size: 11px; color: #999; }
        .members { font-size: 11px; color: #bbb; min-height: 14px; }
        .chat-log {
          flex: 1;
          overflow-y: auto;
          max-height: 220px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding-top: 4px;
          border-top: 1px solid #333;
        }
        .msg { font-size: 12.5px; line-height: 1.35; word-break: break-word; }
        .msg .who { font-weight: 700; color: #E50914; margin-right: 4px; }
        .msg.system { color: #888; font-style: italic; }
        .chat-row { display: flex; gap: 6px; }
        .hidden { display: none !important; }
      </style>
      <div class="panel" id="panel">
        <div class="header" id="header">
          <div class="title"><span class="dot" id="dot"></span>Watch Party</div>
          <button class="min" id="minBtn" title="Minimize">&#8211;</button>
        </div>
        <div class="body" id="body">
          <div class="row"><input id="nameInput" placeholder="Your name" maxlength="24" /></div>
          <div class="row">
            <input id="roomInput" placeholder="Room code" maxlength="40" />
            <button id="connectBtn">Connect</button>
          </div>
          <div class="status" id="status">Not connected</div>
          <div class="members" id="members"></div>
          <div class="chat-log" id="chatLog"></div>
          <div class="chat-row">
            <input id="chatInput" placeholder="Message..." disabled />
            <button id="sendBtn" disabled>Send</button>
          </div>
        </div>
      </div>
    `;

    const els = {
      panel: shadow.getElementById('panel'),
      header: shadow.getElementById('header'),
      minBtn: shadow.getElementById('minBtn'),
      body: shadow.getElementById('body'),
      dot: shadow.getElementById('dot'),
      nameInput: shadow.getElementById('nameInput'),
      roomInput: shadow.getElementById('roomInput'),
      connectBtn: shadow.getElementById('connectBtn'),
      status: shadow.getElementById('status'),
      members: shadow.getElementById('members'),
      chatLog: shadow.getElementById('chatLog'),
      chatInput: shadow.getElementById('chatInput'),
      sendBtn: shadow.getElementById('sendBtn'),
    };

    els.nameInput.value = username;
    els.roomInput.value = roomCode;

    makeDraggable(els.panel, els.header);

    els.minBtn.addEventListener('click', () => {
      els.body.classList.toggle('hidden');
      els.minBtn.innerHTML = els.body.classList.contains('hidden') ? '&#43;' : '&#8211;';
    });

    els.connectBtn.addEventListener('click', () => connect(els));
    els.sendBtn.addEventListener('click', () => sendChat(els));
    els.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat(els);
    });

    return els;
  }

  function makeDraggable(panel, handle) {
    let dragging = false, offsetX = 0, offsetY = 0;
    const start = (x, y) => {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = x - rect.left;
      offsetY = y - rect.top;
    };
    const move = (x, y) => {
      if (!dragging) return;
      panel.style.left = `${x - offsetX}px`;
      panel.style.top = `${y - offsetY}px`;
      panel.style.right = 'auto';
    };
    const end = () => { dragging = false; };

    handle.addEventListener('mousedown', (e) => start(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', end);

    handle.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      start(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      move(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchend', end);
  }

  // ---------- Chat rendering ----------
  function renderMessage(els, msg) {
    const div = document.createElement('div');
    div.className = 'msg' + (msg.system ? ' system' : '');
    if (msg.system) {
      div.textContent = msg.text;
    } else {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = msg.username + ':';
      div.appendChild(who);
      div.appendChild(document.createTextNode(msg.text));
    }
    els.chatLog.appendChild(div);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function renderHistory(els, history) {
    els.chatLog.innerHTML = '';
    history.forEach((m) => renderMessage(els, m));
  }

  function sendChat(els) {
    const text = els.chatInput.value.trim();
    if (!text || !socket || !socket.connected) return;
    socket.emit('chat-message', { text });
    els.chatInput.value = '';
  }

  // ---------- Connection ----------
  function connect(els) {
    username = els.nameInput.value.trim() || 'Guest';
    roomCode = els.roomInput.value.trim();
    if (!roomCode) {
      els.status.textContent = 'Enter a room code first';
      return;
    }
    localStorage.setItem('nwp_name', username);
    localStorage.setItem('nwp_room', roomCode);

    els.connectBtn.disabled = true;
    els.status.textContent = 'Connecting...';

    if (socket) socket.disconnect();
    socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('join-room', { roomCode, username });
    });

    socket.on('room-joined', (data) => {
      els.dot.classList.add('connected');
      els.status.textContent = `Connected to "${data.roomCode}"`;
      els.connectBtn.disabled = false;
      els.connectBtn.textContent = 'Reconnect';
      els.chatInput.disabled = false;
      els.sendBtn.disabled = false;
      renderHistory(els, data.chatHistory);
      startHeartbeat();
      attachVideoListeners();
    });

    socket.on('chat-message', (msg) => renderMessage(els, msg));

    socket.on('presence', (data) => {
      els.members.textContent = data.members.length ? `In room: ${data.members.join(', ')}` : '';
    });

    socket.on('playback-sync', (payload) => applyRemoteAction(payload));
    socket.on('heartbeat-sync', ({ time }) => reconcileDrift(time));

    socket.on('disconnect', () => {
      els.dot.classList.remove('connected');
      els.status.textContent = 'Disconnected — reconnecting...';
    });

    socket.on('connect_error', () => {
      els.status.textContent = 'Could not reach server';
      els.connectBtn.disabled = false;
    });
  }

  // ---------- Playback sync ----------
  function withSuppressed(fn) {
    suppress = true;
    fn();
    setTimeout(() => { suppress = false; }, 400);
  }

  function applyRemoteAction(payload) {
    if (!video) return;
    withSuppressed(() => {
      if (typeof payload.time === 'number' && Math.abs(video.currentTime - payload.time) > 0.4) {
        video.currentTime = payload.time;
      }
      if (payload.action === 'play') video.play().catch(() => {});
      if (payload.action === 'pause') video.pause();
    });
  }

  function reconcileDrift(remoteTime) {
    if (!video || suppress) return;
    if (Math.abs(video.currentTime - remoteTime) > DRIFT_THRESHOLD) {
      withSuppressed(() => { video.currentTime = remoteTime; });
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (video && socket && socket.connected) {
        socket.emit('heartbeat', { time: video.currentTime });
      }
    }, HEARTBEAT_MS);
  }

  function emitPlayback(action) {
    if (!socket || !socket.connected || !video) return;
    socket.emit('playback-event', { action, time: video.currentTime, ts: Date.now() });
  }

  function attachVideoListeners() {
    if (videoListenersAttached || !video) return;
    videoListenersAttached = true;
    video.addEventListener('play', () => { if (!suppress) emitPlayback('play'); });
    video.addEventListener('pause', () => { if (!suppress) emitPlayback('pause'); });
    video.addEventListener('seeked', () => { if (!suppress) emitPlayback('seek'); });
  }

  // ---------- Boot ----------
  waitForVideo((v) => {
    video = v;
    buildUI();
  });

  // Netflix is an SPA — re-find the video element when navigating between titles/episodes
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      videoListenersAttached = false;
      waitForVideo((v) => {
        video = v;
        attachVideoListeners();
      });
    }
  }, 1000);
})();
