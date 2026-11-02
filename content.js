/**
 * IR TickTawk - Chrome Extension Content Script (v1.1.0)
 * - Remembers timer across page refreshes & parses actual message timestamps (e.g., "4:06 AM")
 * - Draggable floating badge that persists position and floats across all browser tabs
 * - Supports Always-on-Top Picture-in-Picture pop-out window
 * - Sounds Web Audio alerts (2-minute chime & 3-minute looping urgent alarm)
 */

(() => {
  'use strict';

  const IS_TOP_FRAME = window === window.top;
  const IS_TAWK_DASHBOARD = window.location.hostname === 'dashboard.tawk.to';
  const SCRIPT_START_TIME = Date.now();
  const LOG_PREFIX = '[IR TickTawk]';

  // Only run on https://dashboard.tawk.to/
  if (!IS_TAWK_DASHBOARD) {
    return;
  }

  // Prevent duplicate initialization in the same frame
  if (window.__IR_TICKTAWK_V111__) return;
  window.__IR_TICKTAWK_V111__ = true;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  // ==========================================
  // CONFIGURATION & THRESHOLDS
  // ==========================================
  const CHIME_THRESHOLD_SEC = 120; // 2 minutes (120 seconds)
  const URGENT_THRESHOLD_SEC = 180; // 3 minutes (180 seconds)
  const URGENT_LOOP_INTERVAL_MS = 1800; // Alarm pulses every 1.8 seconds
  const STORAGE_STATE_KEY = 'ir_ticktawk_shared_state';
  const STORAGE_PREFS_KEY = 'ir_ticktawk_prefs';

  // ==========================================
  // TIMESTAMP PARSER (Parses "4:06 AM" from chat bubble)
  // ==========================================
  function parseMessageTime(timeStr) {
    if (!timeStr) return null;
    const match = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const meridiem = match[3] ? match[3].toUpperCase() : null;

    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;

    const now = new Date();
    const msgDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hours,
      minutes,
      0,
      0
    );

    // Handle midnight rollover (e.g. message at 11:59 PM, now 12:01 AM)
    if (msgDate.getTime() > now.getTime() + 60 * 1000) {
      msgDate.setDate(msgDate.getDate() - 1);
    }

    return msgDate.getTime();
  }

  // ==========================================
  // AUDIO MANAGER (Web Audio API + WAV Fallback)
  // ==========================================
  class AudioManager {
    constructor() {
      this.ctx = null;
      this.isMuted = false;
      this.volume = 0.85;
      this.urgentLoopTimer = null;
      this.activeOscillators = [];
      this.isUrgentLooping = false;
    }

    initContext() {
      if (!this.ctx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          this.ctx = new AudioContextClass();
        }
      }
      return this.ctx;
    }

    async ensureResumed() {
      const ctx = this.initContext();
      if (!ctx) return null;
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (_) {}
      }
      return ctx;
    }

    isAudioUnlocked() {
      return Boolean(this.ctx && this.ctx.state === 'running');
    }

    async playChime() {
      if (this.isMuted) return;
      const ctx = await this.ensureResumed();
      if (!ctx || ctx.state !== 'running') {
        this.playFallbackBeep(659, 0.4);
        return;
      }

      log('Playing 2-Minute Warning Chime 🔔');
      const now = ctx.currentTime;
      const notes = [
        { freq: 659.25, time: 0.00, dur: 0.35, gain: 0.25 }, // E5
        { freq: 880.00, time: 0.16, dur: 0.45, gain: 0.30 }, // A5
        { freq: 1318.51, time: 0.35, dur: 0.80, gain: 0.35 } // E6
      ];

      notes.forEach((note) => {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(note.freq, now + note.time);

        const startTime = now + note.time;
        const endTime = startTime + note.dur;

        gainNode.gain.setValueAtTime(0.001, startTime);
        gainNode.gain.exponentialRampToValueAtTime(note.gain * this.volume, startTime + 0.03);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, endTime);

        osc.connect(gainNode);
        gainNode.connect(ctx.destination);

        osc.start(startTime);
        osc.stop(endTime);
      });
    }

    playUrgentPulse() {
      if (this.isMuted) return;
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') {
        this.playFallbackBeep(880, 0.25);
        return;
      }

      const now = ctx.currentTime;
      const beeps = [
        { freq: 880.0, start: 0.00, dur: 0.14 },
        { freq: 1174.66, start: 0.18, dur: 0.14 },
        { freq: 880.0, start: 0.36, dur: 0.14 },
        { freq: 1396.91, start: 0.54, dur: 0.24 }
      ];

      beeps.forEach((b) => {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(b.freq, now + b.start);

        const startTime = now + b.start;
        const endTime = startTime + b.dur;

        gainNode.gain.setValueAtTime(0.001, startTime);
        gainNode.gain.linearRampToValueAtTime(0.45 * this.volume, startTime + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.001, endTime);

        osc.connect(gainNode);
        gainNode.connect(ctx.destination);

        osc.start(startTime);
        osc.stop(endTime);

        this.activeOscillators.push(osc);
        osc.onended = () => {
          this.activeOscillators = this.activeOscillators.filter((o) => o !== osc);
        };
      });
    }

    async startUrgentAlarm() {
      if (this.isUrgentLooping || this.isMuted) return;
      this.isUrgentLooping = true;
      log('Starting 3-Minute Looping Urgent Alarm 🚨');

      await this.ensureResumed();
      this.playUrgentPulse();

      clearInterval(this.urgentLoopTimer);
      this.urgentLoopTimer = setInterval(() => {
        if (!this.isUrgentLooping || this.isMuted) {
          clearInterval(this.urgentLoopTimer);
          return;
        }
        this.playUrgentPulse();
      }, URGENT_LOOP_INTERVAL_MS);
    }

    stopUrgentAlarm() {
      this.isUrgentLooping = false;
      if (this.urgentLoopTimer) {
        clearInterval(this.urgentLoopTimer);
        this.urgentLoopTimer = null;
      }
      this.activeOscillators.forEach((osc) => {
        try {
          osc.stop();
        } catch (_) {}
      });
      this.activeOscillators = [];
    }

    setMuted(muted) {
      this.isMuted = muted;
      if (muted) {
        this.stopUrgentAlarm();
      }
    }

    playFallbackBeep(freq = 880, duration = 0.2) {
      try {
        const sampleRate = 8000;
        const totalSamples = Math.floor(sampleRate * duration);
        const buffer = new Uint8Array(44 + totalSamples);
        const view = new DataView(buffer.buffer);

        const writeString = (offset, str) => {
          for (let i = 0; i < str.length; i++) buffer[offset + i] = str.charCodeAt(i);
        };
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + totalSamples, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate, true);
        view.setUint16(32, 1, true);
        view.setUint16(34, 8, true);
        writeString(36, 'data');
        view.setUint32(40, totalSamples, true);

        const period = sampleRate / freq;
        for (let i = 0; i < totalSamples; i++) {
          buffer[44 + i] = i % period < period / 2 ? 200 : 55;
        }

        const blob = new Blob([buffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const snd = new Audio(url);
        snd.volume = this.volume;
        snd.play().catch(() => {});
      } catch (_) {}
    }
  }

  // ==========================================
  // SHARED STATE & STORAGE SYNC
  // ==========================================
  const state = {
    waitingSince: null,
    msgKey: '',
    lastVisitorMsgText: '',
    lastVisitorTimeStr: '',
    lastVisitorName: 'Visitor',
    status: 'idle', // 'idle' | 'waiting' | 'warning' | 'urgent' | 'replied' | 'ended'
    chimeFired: false,
    urgentFired: false,
    silenced: false,
    detectedMessagesCount: 0,
    isMinimized: false,
    isMuted: false,
    pos: null // { left, top }
  };

  const audio = new AudioManager();

  function saveSharedState() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local
      .set({
        [STORAGE_STATE_KEY]: {
          waitingSince: state.waitingSince,
          msgKey: state.msgKey,
          lastVisitorMsgText: state.lastVisitorMsgText,
          lastVisitorTimeStr: state.lastVisitorTimeStr,
          lastVisitorName: state.lastVisitorName,
          status: state.status,
          chimeFired: state.chimeFired,
          urgentFired: state.urgentFired,
          silenced: state.silenced,
          detectedMessagesCount: state.detectedMessagesCount,
          updatedAt: Date.now()
        }
      })
      .catch(() => {});
  }

  function savePrefs() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local
      .set({
        [STORAGE_PREFS_KEY]: {
          isMuted: state.isMuted,
          isMinimized: state.isMinimized,
          pos: state.pos
        }
      })
      .catch(() => {});
  }

  function loadInitialStorage() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      chrome.storage.local.get([STORAGE_STATE_KEY, STORAGE_PREFS_KEY], (res) => {
        if (res && res[STORAGE_STATE_KEY]) {
          const s = res[STORAGE_STATE_KEY];
          state.waitingSince = s.waitingSince || null;
          state.msgKey = s.msgKey || '';
          state.lastVisitorMsgText = s.lastVisitorMsgText || '';
          state.lastVisitorTimeStr = s.lastVisitorTimeStr || '';
          state.lastVisitorName = s.lastVisitorName || 'Visitor';
          state.status = s.status || 'idle';
          state.chimeFired = Boolean(s.chimeFired);
          state.urgentFired = Boolean(s.urgentFired);
          state.silenced = Boolean(s.silenced);
          state.detectedMessagesCount = s.detectedMessagesCount || 0;
        }
        if (res && res[STORAGE_PREFS_KEY]) {
          const p = res[STORAGE_PREFS_KEY];
          if (typeof p.isMuted === 'boolean') {
            state.isMuted = p.isMuted;
            audio.setMuted(state.isMuted);
          }
          if (typeof p.isMinimized === 'boolean') {
            state.isMinimized = p.isMinimized;
          }
          if (p.pos && typeof p.pos.left === 'number' && typeof p.pos.top === 'number') {
            state.pos = p.pos;
          }
        }
        resolve();
      });
    });
  }

  // ==========================================
  // DRAGGABLE FLOATING BADGE UI (Shadow DOM + PiP)
  // ==========================================
  class BadgeUI {
    constructor() {
      this.host = null;
      this.shadow = null;
      this.elements = {};
      this.pipWindow = null;
      this.isDragging = false;
      this.dragMoved = false;
      this.dragOffsetX = 0;
      this.dragOffsetY = 0;
      this.init();
    }

    init() {
      const existing = document.getElementById('ir-ticktawk-root');
      if (existing) existing.remove();

      this.host = document.createElement('div');
      this.host.id = 'ir-ticktawk-root';
      this.host.style.cssText = `
        position: fixed !important;
        bottom: 20px !important;
        right: 20px !important;
        z-index: 2147483647 !important;
        display: block !important;
        pointer-events: auto !important;
        margin: 0 !important;
        padding: 0 !important;
        width: auto !important;
        height: auto !important;
        touch-action: none !important;
      `;

      this.shadow = this.host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = this.getStyles();

      const wrapper = document.createElement('div');
      wrapper.className = 'tt-wrapper';
      wrapper.innerHTML = `
        <div class="tt-badge" id="tt-badge">
          <div class="tt-header" id="tt-drag-handle" title="Drag to move anywhere">
            <div class="tt-brand">
              <span class="tt-drag-grip">⋮⋮</span>
              <span class="tt-status-dot idle" id="tt-dot"></span>
              <span>TickTawk</span>
              <span class="tt-mini-timer" id="tt-mini-timer">--:--</span>
            </div>
            <div class="tt-controls">
              <button class="tt-btn-icon" id="tt-btn-pip" title="Pop-out Always-on-Top Floating Window">📌</button>
              <button class="tt-btn-icon" id="tt-btn-mute" title="Toggle Sound">🔔</button>
              <button class="tt-btn-icon" id="tt-btn-min" title="Minimize / Expand">_</button>
            </div>
          </div>
          <div class="tt-body">
            <div class="tt-timer-row">
              <div class="tt-timer" id="tt-timer">00:00</div>
              <div class="tt-status-badge" id="tt-badge-tag">Idle</div>
            </div>
            <div class="tt-desc" id="tt-desc">Monitoring dashboard.tawk.to</div>
            <div class="tt-actions">
              <button class="tt-action-btn" id="tt-btn-test-chime" title="Test 2m Chime sound">Test 2m Chime</button>
              <button class="tt-action-btn" id="tt-btn-test-alarm" title="Test 3m Alarm sound">Test 3m Alarm</button>
              <button class="tt-action-btn silence" id="tt-btn-silence" style="display:none;" title="Stop Alarm">Silence</button>
            </div>
            <div class="tt-actions">
              <button class="tt-action-btn" id="tt-btn-sim" title="Advance wait timer by +1 minute">+1m Sim</button>
              <button class="tt-action-btn" id="tt-btn-reset" title="Reset current timer">Reset</button>
            </div>
            <div class="tt-audio-status locked" id="tt-audio-status">⚠️ Click to Unlock Audio Alerts</div>
          </div>
        </div>
      `;

      this.shadow.appendChild(style);
      this.shadow.appendChild(wrapper);

      this.attachToDOM();

      this.elements = {
        wrapper,
        badge: this.shadow.getElementById('tt-badge'),
        dragHandle: this.shadow.getElementById('tt-drag-handle'),
        dot: this.shadow.getElementById('tt-dot'),
        timer: this.shadow.getElementById('tt-timer'),
        miniTimer: this.shadow.getElementById('tt-mini-timer'),
        badgeTag: this.shadow.getElementById('tt-badge-tag'),
        desc: this.shadow.getElementById('tt-desc'),
        btnPip: this.shadow.getElementById('tt-btn-pip'),
        btnMute: this.shadow.getElementById('tt-btn-mute'),
        btnMin: this.shadow.getElementById('tt-btn-min'),
        btnTestChime: this.shadow.getElementById('tt-btn-test-chime'),
        btnTestAlarm: this.shadow.getElementById('tt-btn-test-alarm'),
        btnSilence: this.shadow.getElementById('tt-btn-silence'),
        btnSim: this.shadow.getElementById('tt-btn-sim'),
        btnReset: this.shadow.getElementById('tt-btn-reset'),
        audioStatus: this.shadow.getElementById('tt-audio-status')
      };

      // Hide PiP button if browser doesn't support documentPictureInPicture
      if (!('documentPictureInPicture' in window)) {
        this.elements.btnPip.style.display = 'none';
      }

      this.bindEvents();
      this.bindDragging();
    }

    getStyles() {
      return `
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        .tt-wrapper {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          color: #ffffff;
          user-select: none;
        }
        .tt-badge {
          background: rgba(17, 24, 39, 0.96);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1.5px solid rgba(255, 255, 255, 0.18);
          border-radius: 14px;
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65), 0 0 1px 1px rgba(255, 255, 255, 0.1);
          padding: 12px 16px;
          min-width: 280px;
          max-width: 350px;
          cursor: grab;
          transition: box-shadow 0.2s, border-color 0.2s;
        }
        .tt-badge.dragging {
          cursor: grabbing !important;
          box-shadow: 0 20px 48px rgba(0, 0, 0, 0.85), 0 0 0 2px rgba(59, 130, 246, 0.6);
        }
        .tt-badge.minimized {
          min-width: auto;
          padding: 8px 14px;
          border-radius: 30px;
        }
        .tt-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
          cursor: grab;
        }
        .tt-badge.dragging .tt-header {
          cursor: grabbing !important;
        }
        .tt-badge.minimized .tt-header {
          margin-bottom: 0;
          gap: 10px;
        }
        .tt-brand {
          display: flex;
          align-items: center;
          gap: 7px;
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }
        .tt-drag-grip {
          color: rgba(255, 255, 255, 0.4);
          font-size: 13px;
          letter-spacing: -1px;
          margin-right: 1px;
        }
        .tt-status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #10b981;
          display: inline-block;
          flex-shrink: 0;
          transition: background-color 0.3s ease;
        }
        .tt-status-dot.idle {
          background: #10b981;
          box-shadow: 0 0 8px #10b981;
        }
        .tt-status-dot.waiting {
          background: #f59e0b;
          box-shadow: 0 0 8px #f59e0b;
        }
        .tt-status-dot.warning {
          background: #f97316;
          box-shadow: 0 0 12px #f97316;
          animation: tt-pulse 1.3s infinite;
        }
        .tt-status-dot.urgent {
          background: #ef4444;
          box-shadow: 0 0 16px #ef4444;
          animation: tt-pulse-fast 0.6s infinite;
        }
        .tt-status-dot.replied {
          background: #06b6d4;
          box-shadow: 0 0 8px #06b6d4;
        }
        @keyframes tt-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.35); opacity: 0.7; }
        }
        @keyframes tt-pulse-fast {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.45); opacity: 0.4; }
        }
        .tt-controls {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .tt-btn-icon {
          background: transparent;
          border: none;
          color: rgba(255, 255, 255, 0.7);
          cursor: pointer;
          padding: 4px 5px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          transition: background 0.15s, color 0.15s;
        }
        .tt-btn-icon:hover {
          background: rgba(255, 255, 255, 0.15);
          color: #ffffff;
        }
        .tt-body {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .tt-badge.minimized .tt-body {
          display: none;
        }
        .tt-timer-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
        }
        .tt-timer {
          font-size: 26px;
          font-weight: 800;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          letter-spacing: -0.5px;
          color: #f3f4f6;
        }
        .tt-mini-timer {
          font-size: 13px;
          font-weight: 700;
          font-family: ui-monospace, SFMono-Regular, monospace;
          color: #f3f4f6;
          margin-left: 4px;
          display: none;
        }
        .tt-badge.minimized .tt-mini-timer {
          display: inline-block;
        }
        .tt-status-badge {
          font-size: 11px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 12px;
          text-transform: uppercase;
          background: rgba(255, 255, 255, 0.1);
          color: #d1d5db;
        }
        .tt-status-badge.warning {
          background: rgba(249, 115, 22, 0.3);
          color: #fed7aa;
          border: 1px solid rgba(249, 115, 22, 0.6);
        }
        .tt-status-badge.urgent {
          background: rgba(239, 68, 68, 0.35);
          color: #fecaca;
          border: 1px solid rgba(239, 68, 68, 0.7);
          animation: tt-pulse 0.9s infinite;
        }
        .tt-desc {
          font-size: 12px;
          color: #9ca3af;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .tt-actions {
          margin-top: 6px;
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .tt-action-btn {
          flex: 1;
          padding: 5px 8px;
          font-size: 11px;
          font-weight: 600;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.08);
          color: #e5e7eb;
          cursor: pointer;
          transition: all 0.15s;
          text-align: center;
        }
        .tt-action-btn:hover {
          background: rgba(255, 255, 255, 0.18);
          color: #ffffff;
        }
        .tt-action-btn.silence {
          background: #ef4444;
          border-color: #dc2626;
          color: #ffffff;
          font-weight: 700;
        }
        .tt-action-btn.silence:hover {
          background: #dc2626;
        }
        .tt-audio-status {
          margin-top: 6px;
          font-size: 11px;
          padding: 4px 8px;
          border-radius: 6px;
          text-align: center;
          cursor: pointer;
          font-weight: 600;
          transition: background 0.2s;
        }
        .tt-audio-status.unlocked {
          background: rgba(16, 185, 129, 0.15);
          color: #6ee7b7;
          border: 1px solid rgba(16, 185, 129, 0.3);
        }
        .tt-audio-status.locked {
          background: rgba(245, 158, 11, 0.25);
          color: #fde68a;
          border: 1px solid rgba(245, 158, 11, 0.5);
          animation: tt-pulse 1.2s infinite;
        }
      `;
    }

    attachToDOM() {
      if (document.body) {
        document.body.appendChild(this.host);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          if (document.body) document.body.appendChild(this.host);
        });
      }
    }

    ensureInDOM() {
      if (this.pipWindow) return; // Currently popped out in Picture-in-Picture
      if (!this.host.isConnected && document.body) {
        document.body.appendChild(this.host);
      }
    }

    applyPosition(pos) {
      if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') {
        this.host.style.setProperty('left', 'auto', 'important');
        this.host.style.setProperty('top', 'auto', 'important');
        this.host.style.setProperty('right', '20px', 'important');
        this.host.style.setProperty('bottom', '20px', 'important');
        return;
      }

      const rect = this.host.getBoundingClientRect();
      const w = rect.width || 290;
      const h = rect.height || 150;
      const maxLeft = Math.max(8, window.innerWidth - w - 8);
      const maxTop = Math.max(8, window.innerHeight - h - 8);

      const clampedLeft = Math.max(8, Math.min(maxLeft, pos.left));
      const clampedTop = Math.max(8, Math.min(maxTop, pos.top));

      this.host.style.setProperty('right', 'auto', 'important');
      this.host.style.setProperty('bottom', 'auto', 'important');
      this.host.style.setProperty('left', `${clampedLeft}px`, 'important');
      this.host.style.setProperty('top', `${clampedTop}px`, 'important');
    }

    bindDragging() {
      const badge = this.elements.badge;

      badge.addEventListener('pointerdown', (e) => {
        if (this.pipWindow) return;
        // Do not start drag if clicking a button
        const path = e.composedPath();
        if (path.some((el) => el && el.tagName === 'BUTTON')) {
          return;
        }

        this.isDragging = true;
        this.dragMoved = false;
        const rect = this.host.getBoundingClientRect();
        this.dragOffsetX = e.clientX - rect.left;
        this.dragOffsetY = e.clientY - rect.top;

        badge.classList.add('dragging');
        try {
          badge.setPointerCapture(e.pointerId);
        } catch (_) {}
      });

      badge.addEventListener('pointermove', (e) => {
        if (!this.isDragging) return;
        this.dragMoved = true;

        const newLeft = e.clientX - this.dragOffsetX;
        const newTop = e.clientY - this.dragOffsetY;

        state.pos = { left: newLeft, top: newTop };
        this.applyPosition(state.pos);
      });

      const endDrag = (e) => {
        if (!this.isDragging) return;
        this.isDragging = false;
        badge.classList.remove('dragging');
        try {
          badge.releasePointerCapture(e.pointerId);
        } catch (_) {}

        if (this.dragMoved) {
          savePrefs();
        }
      };

      badge.addEventListener('pointerup', endDrag);
      badge.addEventListener('pointercancel', endDrag);

      window.addEventListener('resize', () => {
        if (state.pos) {
          this.applyPosition(state.pos);
        }
      });
    }

    async togglePiP() {
      if (!('documentPictureInPicture' in window)) return;

      if (this.pipWindow) {
        this.pipWindow.close();
        return;
      }

      try {
        const pipWin = await window.documentPictureInPicture.requestWindow({
          width: 320,
          height: 215
        });
        this.pipWindow = pipWin;

        const pipStyle = pipWin.document.createElement('style');
        pipStyle.textContent =
          this.getStyles() +
          `
          body {
            margin: 0;
            background: #111827;
            display: flex;
            align-items: stretch;
            justify-content: stretch;
            overflow: hidden;
          }
          .tt-wrapper {
            width: 100%;
            height: 100%;
          }
          .tt-badge {
            width: 100%;
            height: 100%;
            max-width: none;
            border-radius: 0;
            border: none;
          }
        `;
        pipWin.document.head.appendChild(pipStyle);
        pipWin.document.body.appendChild(this.elements.wrapper);
        this.host.style.setProperty('display', 'none', 'important');

        pipWin.addEventListener('pagehide', () => {
          this.pipWindow = null;
          this.shadow.appendChild(this.elements.wrapper);
          this.host.style.setProperty('display', 'block', 'important');
        });
      } catch (err) {
        console.warn(LOG_PREFIX, 'Failed to open Picture-in-Picture window:', err);
      }
    }

    bindEvents() {
      // Pop-out Always-on-Top PiP window
      this.elements.btnPip.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.togglePiP();
      });

      // Audio Unmute / Mute
      this.elements.btnMute.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        state.isMuted = !state.isMuted;
        audio.setMuted(state.isMuted);
        this.updateMuteIcon();
        savePrefs();
      });

      // Minimize / Expand
      this.elements.btnMin.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMinimize();
      });

      this.elements.badge.addEventListener('click', async () => {
        if (this.dragMoved) return;
        await audio.ensureResumed();
        this.updateAudioIndicator();
        if (state.isMinimized) {
          this.toggleMinimize(false);
        }
      });

      // Test 2-minute chime
      this.elements.btnTestChime.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();
        audio.playChime();
      });

      // Test 3-minute urgent alarm
      this.elements.btnTestAlarm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();
        if (audio.isUrgentLooping) {
          audio.stopUrgentAlarm();
          this.elements.btnTestAlarm.textContent = 'Test 3m Alarm';
          this.elements.btnSilence.style.display = 'none';
        } else {
          audio.startUrgentAlarm();
          this.elements.btnTestAlarm.textContent = 'Stop Alarm';
          this.elements.btnSilence.style.display = 'inline-block';
        }
      });

      // Silence Alarm button (syncs across all tabs)
      this.elements.btnSilence.addEventListener('click', (e) => {
        e.stopPropagation();
        audio.stopUrgentAlarm();
        state.silenced = true;
        this.elements.btnSilence.style.display = 'none';
        this.elements.btnTestAlarm.textContent = 'Test 3m Alarm';
        saveSharedState();
      });

      // Simulate visitor wait time (+60s each click)
      this.elements.btnSim.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();

        if (!state.waitingSince) {
          state.waitingSince = Date.now() - 60 * 1000;
          state.lastVisitorMsgText = state.lastVisitorMsgText || 'Simulated visitor message';
          state.status = 'waiting';
          state.chimeFired = false;
          state.urgentFired = false;
          state.silenced = false;
        } else {
          state.waitingSince -= 60 * 1000;
        }
        saveSharedState();
      });

      // Reset timer manually
      this.elements.btnReset.addEventListener('click', (e) => {
        e.stopPropagation();
        audio.stopUrgentAlarm();
        state.waitingSince = null;
        state.status = 'idle';
        state.chimeFired = false;
        state.urgentFired = false;
        state.silenced = false;
        this.elements.btnSilence.style.display = 'none';
        this.elements.btnTestAlarm.textContent = 'Test 3m Alarm';
        saveSharedState();
        this.updateStatus('idle', 0);
      });

      // Unlock Audio Status click
      this.elements.audioStatus.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();
        audio.playChime();
      });
    }

    toggleMinimize(force, persist = true) {
      state.isMinimized = force !== undefined ? force : !state.isMinimized;
      if (state.isMinimized) {
        this.elements.badge.classList.add('minimized');
        this.elements.miniTimer.style.display = 'inline-block';
        this.elements.btnMin.textContent = '+';
      } else {
        this.elements.badge.classList.remove('minimized');
        this.elements.miniTimer.style.display = 'none';
        this.elements.btnMin.textContent = '_';
      }
      if (persist) savePrefs();
    }

    updateMuteIcon() {
      this.elements.btnMute.textContent = state.isMuted ? '🔕' : '🔔';
      this.elements.btnMute.title = state.isMuted ? 'Unmute Sound' : 'Mute Sound';
    }

    updateAudioIndicator() {
      if (audio.isAudioUnlocked()) {
        this.elements.audioStatus.textContent = '🔊 Audio Ready (Alerts Active)';
        this.elements.audioStatus.className = 'tt-audio-status unlocked';
      } else {
        this.elements.audioStatus.textContent = '⚠️ Click to Unlock Audio Alerts';
        this.elements.audioStatus.className = 'tt-audio-status locked';
      }
    }

    updateStatus(status, elapsedSec = 0, messageSnippet = '') {
      const minutes = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const seconds = String(elapsedSec % 60).padStart(2, '0');
      const timeStr = `${minutes}:${seconds}`;

      this.elements.timer.textContent = timeStr;
      this.elements.miniTimer.textContent = timeStr;

      this.elements.dot.className = `tt-status-dot ${status}`;
      this.elements.badgeTag.className = `tt-status-badge ${status}`;

      const timeLabel = state.lastVisitorTimeStr ? ` (${state.lastVisitorTimeStr})` : '';

      switch (status) {
        case 'idle':
          this.elements.timer.textContent = '00:00';
          this.elements.miniTimer.textContent = '--:--';
          this.elements.badgeTag.textContent = 'Idle';
          this.elements.desc.textContent = `Monitoring (${state.detectedMessagesCount} msgs detected)`;
          this.elements.btnSilence.style.display = 'none';
          break;

        case 'waiting':
          this.elements.badgeTag.textContent = 'Waiting';
          this.elements.desc.textContent = messageSnippet
            ? `${state.lastVisitorName}${timeLabel}: "${messageSnippet}"`
            : `${state.lastVisitorName}${timeLabel} waiting...`;
          this.elements.btnSilence.style.display = 'none';
          break;

        case 'warning':
          this.elements.badgeTag.textContent = '2m Warning';
          this.elements.desc.textContent = `Waiting > 2m${timeLabel}: "${messageSnippet}"`;
          this.elements.btnSilence.style.display = 'none';
          break;

        case 'urgent':
          this.elements.badgeTag.textContent = '3m Urgent!';
          this.elements.desc.textContent = `URGENT > 3m${timeLabel}: "${messageSnippet}"`;
          if (audio.isUrgentLooping || !state.silenced) {
            this.elements.btnSilence.style.display = 'inline-block';
          }
          break;

        case 'replied':
          this.elements.timer.textContent = '00:00';
          this.elements.badgeTag.textContent = 'Replied';
          this.elements.desc.textContent = 'Agent replied! Timer reset.';
          this.elements.btnSilence.style.display = 'none';
          break;

        case 'ended':
          this.elements.timer.textContent = '00:00';
          this.elements.badgeTag.textContent = 'Ended';
          this.elements.desc.textContent = 'Visitor ended chat.';
          this.elements.btnSilence.style.display = 'none';
          break;
      }

      this.updateAudioIndicator();
    }
  }

  // ==========================================
  // TAWK.TO MESSAGE DETECTOR & TIMER ENGINE
  // ==========================================
  class TawkController {
    constructor(badge) {
      this.badge = badge;
      this.observer = null;
      this.scanScheduled = false;
      this.tickInterval = null;
    }

    async start() {
      await loadInitialStorage();

      if (this.badge) {
        this.badge.updateMuteIcon();
        this.badge.toggleMinimize(state.isMinimized, false);
        if (state.pos) {
          this.badge.applyPosition(state.pos);
        }
      }

      // Listen for storage updates from other tabs
      this.bindStorageSync();

      // Unlock AudioContext on any user interaction in this tab
      const unlockAudio = () => {
        audio.ensureResumed().then(() => {
          if (this.badge) this.badge.updateAudioIndicator();
        });
      };
      ['click', 'keydown', 'mousedown', 'touchstart'].forEach((evt) => {
        window.addEventListener(evt, unlockAudio, { passive: true, capture: true });
      });

      // Scan DOM for Tawk.to chats on dashboard.tawk.to
      if (IS_TAWK_DASHBOARD) {
        this.observeDOM();
        this.bindAgentInteractions();
        this.scan();
      }

      this.startTimerTick();
    }

    bindStorageSync() {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes[STORAGE_STATE_KEY] && changes[STORAGE_STATE_KEY].newValue) {
          const s = changes[STORAGE_STATE_KEY].newValue;
          state.waitingSince = s.waitingSince || null;
          state.msgKey = s.msgKey || '';
          state.lastVisitorMsgText = s.lastVisitorMsgText || '';
          state.lastVisitorTimeStr = s.lastVisitorTimeStr || '';
          state.lastVisitorName = s.lastVisitorName || 'Visitor';
          state.status = s.status || 'idle';
          state.chimeFired = Boolean(s.chimeFired);
          state.urgentFired = Boolean(s.urgentFired);
          state.silenced = Boolean(s.silenced);
          state.detectedMessagesCount = s.detectedMessagesCount || 0;

          if (!state.waitingSince || state.silenced || state.status === 'replied' || state.status === 'idle') {
            audio.stopUrgentAlarm();
          }
        }

        if (changes[STORAGE_PREFS_KEY] && changes[STORAGE_PREFS_KEY].newValue) {
          const p = changes[STORAGE_PREFS_KEY].newValue;
          if (typeof p.isMuted === 'boolean') {
            state.isMuted = p.isMuted;
            audio.setMuted(state.isMuted);
            if (this.badge) this.badge.updateMuteIcon();
          }
          if (typeof p.isMinimized === 'boolean' && this.badge) {
            this.badge.toggleMinimize(p.isMinimized, false);
          }
          if (p.pos && this.badge && !this.badge.isDragging) {
            state.pos = p.pos;
            this.badge.applyPosition(state.pos);
          }
        }
      });
    }

    observeDOM() {
      this.observer = new MutationObserver(() => {
        if (!this.scanScheduled) {
          this.scanScheduled = true;
          requestAnimationFrame(() => {
            this.scanScheduled = false;
            this.scan();
          });
        }
      });

      this.observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    bindAgentInteractions() {
      document.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            const target = e.target;
            if (
              target &&
              (target.tagName === 'TEXTAREA' ||
                target.isContentEditable ||
                (target.tagName === 'INPUT' && target.type === 'text'))
            ) {
              const val = (target.value || target.innerText || '').trim();
              if (val.length > 0) {
                log('Agent pressed Enter with text to send message');
                this.onAgentReplied('Agent sent reply');
              }
            }
          }
        },
        true
      );
    }

    /**
     * Walks up from a timestamp node ("4:06 AM") to isolate its single message bubble
     * without merging multiple messages together.
     */
    getBubbleAndGroup(timeEl) {
      let curr = timeEl.parentElement;
      let bubble = curr;
      const timeRegexGlobal = /\b\d{1,2}:\d{2}\s*(?:[AP]M)?\b/gi;

      for (let depth = 0; depth < 4 && curr && curr !== document.body; depth++) {
        const text = curr.innerText || '';
        const matches = text.match(timeRegexGlobal) || [];
        if (matches.length > 1) {
          break;
        }
        const rect = curr.getBoundingClientRect();
        if (rect.width > 650 && rect.height > 300) {
          break;
        }
        bubble = curr;
        curr = curr.parentElement;
      }

      // The sender group container is 1-2 levels above the bubble (contains "Joe" or "Ivan (Me)")
      const group = bubble?.parentElement?.parentElement || bubble?.parentElement || bubble;
      return { bubble, group };
    }

    scan() {
      if (this.badge) {
        this.badge.ensureInDOM();
      }

      const bodyText = (document.body ? document.body.innerText : '') || '';

      // 1. Find all message bubbles anchored by timestamps (e.g. "4:06 AM")
      const timeRegex = /\b\d{1,2}:\d{2}\s*(?:[AP]M)?\b/i;
      const allTextNodes = document.querySelectorAll('span, div, p, time, small, em');
      const messageItems = [];
      const seenBubbles = new Set();

      for (const el of allTextNodes) {
        if (el.children.length === 0) {
          const text = (el.textContent || '').trim();
          if (timeRegex.test(text) && text.length <= 12) {
            const rect = el.getBoundingClientRect();
            // Ensure timestamp is inside the central chat view (not left sidebar)
            if (rect.left > 150 && rect.top > 60) {
              const { bubble, group } = this.getBubbleAndGroup(el);
              if (bubble && !seenBubbles.has(bubble)) {
                seenBubbles.add(bubble);
                const timeMatch = text.match(timeRegex);
                messageItems.push({
                  bubble,
                  group,
                  timeStr: timeMatch ? timeMatch[0] : text
                });
              }
            }
          }
        }
      }

      state.detectedMessagesCount = messageItems.length;
      if (messageItems.length === 0) return;

      // 2. Check if "Visitor has ended the chat" appears after the last message
      if (bodyText.includes('has ended the chat') || bodyText.includes('chat has ended')) {
        const lastBubble = messageItems[messageItems.length - 1].bubble;
        const lastBubbleText = (lastBubble.innerText || '').trim();
        const endedIdx = bodyText.lastIndexOf('ended the chat');
        const bubbleIdx = bodyText.lastIndexOf(lastBubbleText);
        if (endedIdx > bubbleIdx) {
          if (state.status !== 'ended') {
            state.status = 'ended';
            state.waitingSince = null;
            state.msgKey = '';
            audio.stopUrgentAlarm();
            saveSharedState();
            if (this.badge) this.badge.updateStatus('ended', 0);
          }
          return;
        }
      }

      // 3. Inspect messages from newest to oldest, ignoring "(System Message)"
      let lastSender = 'unknown';
      let lastText = '';
      let lastTimeStr = '';
      let visitorName = 'Visitor';

      for (let i = messageItems.length - 1; i >= 0; i--) {
        const { bubble, group, timeStr } = messageItems[i];
        const bubbleText = (bubble.innerText || '').trim();
        const groupText = (group ? group.innerText || '' : bubbleText).trim();
        const groupHTML = (group ? group.innerHTML || '' : '').toLowerCase();

        // Skip automatic System Messages (e.g. "Customer Support (System Message)")
        if (
          groupText.includes('(System Message)') ||
          bubbleText.includes('(System Message)') ||
          bubbleText.includes('has ended the chat')
        ) {
          continue;
        }

        // Check if sent by Agent ("(Me)", right-aligned bubble, or agent class)
        const bubbleRect = bubble.getBoundingClientRect();
        const groupRect = group ? group.getBoundingClientRect() : bubbleRect;
        const isRightAligned =
          groupRect.width > 200 && bubbleRect.left - groupRect.left > 80;

        const isAgent =
          groupText.includes('(Me)') ||
          groupText.includes('(me)') ||
          groupHTML.includes('tawk-agent') ||
          groupHTML.includes('outgoing') ||
          isRightAligned;

        if (isAgent) {
          lastSender = 'agent';
          lastText = bubbleText.replace(/\b\d{1,2}:\d{2}\s*(?:[AP]M)?\b/gi, '').trim();
          lastTimeStr = timeStr;
          break;
        }

        // Otherwise, it's a Visitor message
        if (bubbleText.length > 0) {
          lastSender = 'visitor';
          lastTimeStr = timeStr;

          // Extract visitor name from group header (first line of groupText if short)
          const groupLines = groupText.split('\n').map((l) => l.trim()).filter(Boolean);
          if (groupLines.length > 1 && groupLines[0].length <= 25 && !groupLines[0].includes(':')) {
            visitorName = groupLines[0];
          }

          lastText = bubbleText
            .replace(/\b\d{1,2}:\d{2}\s*(?:[AP]M)?\b/gi, '')
            .replace(new RegExp(`^${visitorName}\\s*`, 'i'), '')
            .trim();
          break;
        }
      }

      // 4. Update state based on the latest message in the chat
      if (lastSender === 'agent') {
        if (state.status !== 'idle' && state.status !== 'replied') {
          log('Last message in chat is from AGENT:', lastText);
          this.onAgentReplied(lastText);
        }
      } else if (lastSender === 'visitor') {
        const currentMsgKey = `${visitorName}|${lastTimeStr}|${lastText}`;
        state.lastVisitorName = visitorName;
        state.lastVisitorMsgText = lastText;
        state.lastVisitorTimeStr = lastTimeStr;

        // If this exact message is ALREADY being tracked (e.g., before page refresh),
        // keep its existing waitingSince timestamp so refreshing NEVER resets to 0!
        if (state.msgKey === currentMsgKey && state.waitingSince) {
          return;
        }

        // Otherwise, compute waitingSince from the message's actual timestamp ("4:06 AM")
        const parsedMsgTimestamp = parseMessageTime(lastTimeStr);
        const now = Date.now();
        const isInitialPageLoad = now - SCRIPT_START_TIME < 6000;

        if (parsedMsgTimestamp && (now - parsedMsgTimestamp >= 60 * 1000 || isInitialPageLoad)) {
          // Message timestamp is from an earlier minute or we just refreshed/loaded the page:
          // Use the parsed message time (e.g., 4:06 AM)
          state.waitingSince = parsedMsgTimestamp;
        } else {
          // Brand new message arrived live while watching: record exact millisecond
          state.waitingSince = now;
        }

        const initialElapsedSec = Math.floor((now - state.waitingSince) / 1000);
        state.msgKey = currentMsgKey;
        state.chimeFired = initialElapsedSec >= CHIME_THRESHOLD_SEC;
        state.urgentFired = false;
        state.silenced = false;
        state.status = 'waiting';

        log(
          `Tracking visitor message [${currentMsgKey}] waitingSince=${new Date(
            state.waitingSince
          ).toLocaleTimeString()} (elapsed: ${initialElapsedSec}s)`
        );

        saveSharedState();
      }
    }

    onAgentReplied(text) {
      state.status = 'replied';
      state.waitingSince = null;
      state.msgKey = '';
      state.chimeFired = false;
      state.urgentFired = false;
      state.silenced = false;

      audio.stopUrgentAlarm();
      saveSharedState();

      if (this.badge) {
        this.badge.updateStatus('replied', 0);
      }

      setTimeout(() => {
        if (state.status === 'replied') {
          state.status = 'idle';
          saveSharedState();
          if (this.badge) this.badge.updateStatus('idle', 0);
        }
      }, 4000);
    }

    /**
     * Runs every 1 second in all tabs to update the badge countdown & sound alerts.
     */
    startTimerTick() {
      clearInterval(this.tickInterval);
      this.tickInterval = setInterval(() => {
        if (!state.waitingSince) {
          if (this.badge && state.status !== 'replied' && state.status !== 'ended') {
            this.badge.updateStatus('idle', 0);
          }
          return;
        }

        const elapsedSec = Math.max(0, Math.floor((Date.now() - state.waitingSince) / 1000));
        const shouldPlayAudioHere = IS_TAWK_DASHBOARD || document.visibilityState === 'visible';

        if (elapsedSec < CHIME_THRESHOLD_SEC) {
          state.status = 'waiting';
          if (this.badge) this.badge.updateStatus('waiting', elapsedSec, state.lastVisitorMsgText);
        } else if (elapsedSec >= CHIME_THRESHOLD_SEC && elapsedSec < URGENT_THRESHOLD_SEC) {
          state.status = 'warning';
          if (this.badge) this.badge.updateStatus('warning', elapsedSec, state.lastVisitorMsgText);

          if (!state.chimeFired && shouldPlayAudioHere) {
            state.chimeFired = true;
            saveSharedState();
            audio.playChime();
          }
        } else if (elapsedSec >= URGENT_THRESHOLD_SEC) {
          state.status = 'urgent';
          if (this.badge) this.badge.updateStatus('urgent', elapsedSec, state.lastVisitorMsgText);

          if (!state.silenced && shouldPlayAudioHere && !audio.isUrgentLooping) {
            state.urgentFired = true;
            saveSharedState();
            audio.startUrgentAlarm();
          }
        }
      }, 1000);
    }
  }

  // ==========================================
  // INITIALIZE
  // ==========================================
  if (IS_TOP_FRAME) {
    const badgeUI = new BadgeUI();
    const controller = new TawkController(badgeUI);
    controller.start();
  } else if (IS_TAWK_DASHBOARD) {
    // Subframe inside dashboard.tawk.to
    const subController = new TawkController(null);
    subController.start();
  }
})();
