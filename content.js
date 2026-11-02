/**
 * IR TickTawk - Chrome Extension Content Script (v1.2.0)
 * - Default 1st Pre-Alarm Chime at 1:45 (105s) and Max Urgent Looping Alarm at 3:00 (180s)
 * - User-configurable alarm thresholds inside the floating modal box
 * - Remembers timer across page refreshes & parses actual message timestamps (e.g., "4:06 AM")
 * - Draggable floating badge + Always-on-Top Picture-in-Picture pop-out window
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
  if (window.__IR_TICKTAWK_V121__) return;
  window.__IR_TICKTAWK_V121__ = true;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  // ==========================================
  // CONFIGURATION & DEFAULT THRESHOLDS
  // ==========================================
  const DEFAULT_CHIME_SEC = 105; // 1:45 (15 seconds before 2m) pre-alarm chime
  const DEFAULT_URGENT_SEC = 180; // 3:00 (180 seconds) max urgent alarm
  const URGENT_LOOP_INTERVAL_MS = 1800; // Alarm pulses every 1.8 seconds
  const STORAGE_STATE_KEY = 'ir_ticktawk_shared_state';
  const STORAGE_PREFS_KEY = 'ir_ticktawk_prefs';

  function formatShortTime(totalSec) {
    const m = Math.floor(totalSec / 60);
    const s = String(totalSec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

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

      log(`Playing Pre-Alarm Chime (${formatShortTime(state.chimeThresholdSec)}) 🔔`);
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
      log(`Starting Max Urgent Looping Alarm (${formatShortTime(state.urgentThresholdSec)}) 🚨`);

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
    pos: null, // { left, top }
    chimeThresholdSec: DEFAULT_CHIME_SEC,
    urgentThresholdSec: DEFAULT_URGENT_SEC
  };

  const audio = new AudioManager();

  function saveSharedState() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local
      .set({
        [STORAGE_STATE_KEY]: {
          schemaVersion: 2,
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
          pos: state.pos,
          chimeThresholdSec: state.chimeThresholdSec,
          urgentThresholdSec: state.urgentThresholdSec
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
          // Only restore state created by schemaVersion 2 (verified visitor chats, not DMs)
          if (s.schemaVersion === 2) {
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
          } else {
            // Clear any old state that may have been triggered by a DM
            saveSharedState();
          }
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
          if (typeof p.chimeThresholdSec === 'number' && p.chimeThresholdSec >= 5) {
            state.chimeThresholdSec = p.chimeThresholdSec;
          }
          if (typeof p.urgentThresholdSec === 'number' && p.urgentThresholdSec > state.chimeThresholdSec) {
            state.urgentThresholdSec = p.urgentThresholdSec;
          }
        }
        resolve();
      });
    });
  }

  // ==========================================
  // DRAGGABLE FLOATING BADGE UI (Shadow DOM + PiP + Settings)
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
      this.settingsOpen = false;
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
              <button class="tt-btn-icon" id="tt-btn-settings" title="Configure Alarm Times">⚙️</button>
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

            <!-- Collapsible Alarm Settings Box -->
            <div class="tt-settings-panel" id="tt-settings-panel" style="display:none;">
              <div class="tt-settings-title">Alarm Thresholds</div>
              <div class="tt-setting-row">
                <label class="tt-setting-label">1st Pre-Alarm:</label>
                <div class="tt-time-inputs">
                  <input type="number" id="tt-chime-min" class="tt-num-input" min="0" max="59" value="1" />
                  <span class="tt-unit">m</span>
                  <input type="number" id="tt-chime-sec" class="tt-num-input" min="0" max="59" value="45" />
                  <span class="tt-unit">s</span>
                </div>
              </div>
              <div class="tt-setting-row">
                <label class="tt-setting-label">Max Urgent:</label>
                <div class="tt-time-inputs">
                  <input type="number" id="tt-urgent-min" class="tt-num-input" min="0" max="59" value="3" />
                  <span class="tt-unit">m</span>
                  <input type="number" id="tt-urgent-sec" class="tt-num-input" min="0" max="59" value="0" />
                  <span class="tt-unit">s</span>
                </div>
              </div>
              <div class="tt-settings-actions">
                <button class="tt-action-btn save" id="tt-btn-save-settings">Save</button>
                <button class="tt-action-btn" id="tt-btn-default-settings" title="Reset to 1:45 and 3:00">Defaults (1:45 / 3:00)</button>
              </div>
            </div>

            <div class="tt-actions">
              <button class="tt-action-btn" id="tt-btn-test-chime" title="Test 1st Pre-Alarm Chime">Test 1:45 Chime</button>
              <button class="tt-action-btn" id="tt-btn-test-alarm" title="Test Max Urgent Alarm">Test 3:00 Alarm</button>
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
        btnSettings: this.shadow.getElementById('tt-btn-settings'),
        btnPip: this.shadow.getElementById('tt-btn-pip'),
        btnMute: this.shadow.getElementById('tt-btn-mute'),
        btnMin: this.shadow.getElementById('tt-btn-min'),
        settingsPanel: this.shadow.getElementById('tt-settings-panel'),
        inputChimeMin: this.shadow.getElementById('tt-chime-min'),
        inputChimeSec: this.shadow.getElementById('tt-chime-sec'),
        inputUrgentMin: this.shadow.getElementById('tt-urgent-min'),
        inputUrgentSec: this.shadow.getElementById('tt-urgent-sec'),
        btnSaveSettings: this.shadow.getElementById('tt-btn-save-settings'),
        btnDefaultSettings: this.shadow.getElementById('tt-btn-default-settings'),
        btnTestChime: this.shadow.getElementById('tt-btn-test-chime'),
        btnTestAlarm: this.shadow.getElementById('tt-btn-test-alarm'),
        btnSilence: this.shadow.getElementById('tt-btn-silence'),
        btnSim: this.shadow.getElementById('tt-btn-sim'),
        btnReset: this.shadow.getElementById('tt-btn-reset'),
        audioStatus: this.shadow.getElementById('tt-audio-status')
      };

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
          min-width: 285px;
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
          gap: 3px;
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
        .tt-btn-icon:hover, .tt-btn-icon.active {
          background: rgba(255, 255, 255, 0.16);
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
        /* Settings Panel */
        .tt-settings-panel {
          margin-top: 6px;
          padding: 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          cursor: default;
        }
        .tt-settings-title {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          color: #93c5fd;
        }
        .tt-setting-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .tt-setting-label {
          font-size: 12px;
          color: #e5e7eb;
          font-weight: 500;
        }
        .tt-time-inputs {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .tt-num-input {
          width: 44px;
          padding: 4px 6px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(17, 24, 39, 0.9);
          color: #ffffff;
          font-size: 12px;
          font-weight: 700;
          font-family: ui-monospace, SFMono-Regular, monospace;
          text-align: center;
          outline: none;
        }
        .tt-num-input:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35);
        }
        .tt-unit {
          font-size: 11px;
          color: #9ca3af;
          font-weight: 600;
        }
        .tt-settings-actions {
          display: flex;
          gap: 6px;
          margin-top: 2px;
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
        .tt-action-btn.save {
          background: #2563eb;
          border-color: #3b82f6;
          color: #ffffff;
        }
        .tt-action-btn.save:hover {
          background: #1d4ed8;
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
      if (this.pipWindow) return;
      if (!this.host.isConnected && document.body) {
        document.body.appendChild(this.host);
      }
    }

    syncThresholdInputsAndLabels() {
      const cMin = Math.floor(state.chimeThresholdSec / 60);
      const cSec = state.chimeThresholdSec % 60;
      const uMin = Math.floor(state.urgentThresholdSec / 60);
      const uSec = state.urgentThresholdSec % 60;

      this.elements.inputChimeMin.value = String(cMin);
      this.elements.inputChimeSec.value = String(cSec).padStart(2, '0');
      this.elements.inputUrgentMin.value = String(uMin);
      this.elements.inputUrgentSec.value = String(uSec).padStart(2, '0');

      const chimeLabel = formatShortTime(state.chimeThresholdSec);
      const urgentLabel = formatShortTime(state.urgentThresholdSec);

      this.elements.btnTestChime.textContent = `Test ${chimeLabel} Chime`;
      if (!audio.isUrgentLooping) {
        this.elements.btnTestAlarm.textContent = `Test ${urgentLabel} Alarm`;
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
      const h = rect.height || 160;
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
        const path = e.composedPath();
        // Do not start drag when interacting with buttons, inputs, or settings panel
        if (
          path.some(
            (el) =>
              el &&
              (el.tagName === 'BUTTON' ||
                el.tagName === 'INPUT' ||
                el.id === 'tt-settings-panel')
          )
        ) {
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
          width: 325,
          height: 260
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
            overflow-x: hidden;
            overflow-y: auto;
          }
          .tt-wrapper {
            width: 100%;
            height: 100%;
          }
          .tt-badge {
            width: 100%;
            min-height: 100%;
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
      // Stop keyboard events inside settings inputs from bubbling to Tawk.to
      [
        this.elements.inputChimeMin,
        this.elements.inputChimeSec,
        this.elements.inputUrgentMin,
        this.elements.inputUrgentSec
      ].forEach((input) => {
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            this.saveThresholdSettings();
          }
        });
      });

      // Toggle Settings Drawer
      this.elements.btnSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        this.settingsOpen = !this.settingsOpen;
        this.elements.settingsPanel.style.display = this.settingsOpen ? 'flex' : 'none';
        this.elements.btnSettings.classList.toggle('active', this.settingsOpen);
        if (this.settingsOpen) {
          this.syncThresholdInputsAndLabels();
        }
      });

      // Save Custom Alarm Thresholds
      this.elements.btnSaveSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        this.saveThresholdSettings();
      });

      // Reset to Defaults (1:45 and 3:00)
      this.elements.btnDefaultSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        state.chimeThresholdSec = DEFAULT_CHIME_SEC;
        state.urgentThresholdSec = DEFAULT_URGENT_SEC;
        this.syncThresholdInputsAndLabels();
        savePrefs();
        this.flashSavedFeedback();
      });

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

      // Test Pre-Alarm Chime
      this.elements.btnTestChime.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();
        audio.playChime();
      });

      // Test Max Urgent Alarm
      this.elements.btnTestAlarm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();
        if (audio.isUrgentLooping) {
          audio.stopUrgentAlarm();
          this.elements.btnTestAlarm.textContent = `Test ${formatShortTime(
            state.urgentThresholdSec
          )} Alarm`;
          this.elements.btnSilence.style.display = 'none';
        } else {
          audio.startUrgentAlarm();
          this.elements.btnTestAlarm.textContent = 'Stop Alarm';
          this.elements.btnSilence.style.display = 'inline-block';
        }
      });

      // Silence Alarm button
      this.elements.btnSilence.addEventListener('click', (e) => {
        e.stopPropagation();
        audio.stopUrgentAlarm();
        state.silenced = true;
        this.elements.btnSilence.style.display = 'none';
        this.elements.btnTestAlarm.textContent = `Test ${formatShortTime(
          state.urgentThresholdSec
        )} Alarm`;
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
        this.elements.btnTestAlarm.textContent = `Test ${formatShortTime(
          state.urgentThresholdSec
        )} Alarm`;
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

    saveThresholdSettings() {
      const cMin = Math.max(0, parseInt(this.elements.inputChimeMin.value, 10) || 0);
      const cSec = Math.max(0, Math.min(59, parseInt(this.elements.inputChimeSec.value, 10) || 0));
      const uMin = Math.max(0, parseInt(this.elements.inputUrgentMin.value, 10) || 0);
      const uSec = Math.max(0, Math.min(59, parseInt(this.elements.inputUrgentSec.value, 10) || 0));

      let chimeTotal = Math.max(5, cMin * 60 + cSec);
      let urgentTotal = uMin * 60 + uSec;

      if (urgentTotal <= chimeTotal) {
        urgentTotal = chimeTotal + 15;
      }

      state.chimeThresholdSec = chimeTotal;
      state.urgentThresholdSec = urgentTotal;

      // Re-evaluate chime/urgent flags against current elapsed time if waiting
      if (state.waitingSince) {
        const elapsed = Math.floor((Date.now() - state.waitingSince) / 1000);
        if (elapsed < state.chimeThresholdSec) {
          state.chimeFired = false;
          state.urgentFired = false;
          audio.stopUrgentAlarm();
        } else if (elapsed < state.urgentThresholdSec) {
          state.urgentFired = false;
          audio.stopUrgentAlarm();
        }
        saveSharedState();
      }

      this.syncThresholdInputsAndLabels();
      savePrefs();
      this.flashSavedFeedback();
    }

    flashSavedFeedback() {
      const btn = this.elements.btnSaveSettings;
      const orig = btn.textContent;
      btn.textContent = '✓ Saved!';
      setTimeout(() => {
        btn.textContent = orig;
      }, 1200);
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
      const chimeStr = formatShortTime(state.chimeThresholdSec);
      const urgentStr = formatShortTime(state.urgentThresholdSec);

      switch (status) {
        case 'idle':
          this.elements.timer.textContent = '00:00';
          this.elements.miniTimer.textContent = '--:--';
          this.elements.badgeTag.textContent = 'Idle';
          this.elements.desc.textContent = `Pre-alarm ${chimeStr} · Max ${urgentStr} (${state.detectedMessagesCount} msgs)`;
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
          this.elements.badgeTag.textContent = `${chimeStr} Pre-Alarm`;
          this.elements.desc.textContent = `Pre-Alarm > ${chimeStr}${timeLabel}: "${messageSnippet}"`;
          this.elements.btnSilence.style.display = 'none';
          break;

        case 'urgent':
          this.elements.badgeTag.textContent = `${urgentStr} Urgent!`;
          this.elements.desc.textContent = `URGENT > ${urgentStr}${timeLabel}: "${messageSnippet}"`;
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
        this.badge.syncThresholdInputsAndLabels();
        this.badge.toggleMinimize(state.isMinimized, false);
        if (state.pos) {
          this.badge.applyPosition(state.pos);
        }
      }

      this.bindStorageSync();

      const unlockAudio = () => {
        audio.ensureResumed().then(() => {
          if (this.badge) this.badge.updateAudioIndicator();
        });
      };
      ['click', 'keydown', 'mousedown', 'touchstart'].forEach((evt) => {
        window.addEventListener(evt, unlockAudio, { passive: true, capture: true });
      });

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
          if (typeof p.chimeThresholdSec === 'number') {
            state.chimeThresholdSec = p.chimeThresholdSec;
          }
          if (typeof p.urgentThresholdSec === 'number') {
            state.urgentThresholdSec = p.urgentThresholdSec;
          }
          if (this.badge) {
            this.badge.syncThresholdInputsAndLabels();
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

    /**
     * Returns true ONLY when the active view is a customer/visitor chat,
     * and returns false when viewing internal Agent DMs or Group Chats (e.g., "DMs" sidebar).
     */
    isVisitorChatContext(bodyText) {
      const text = bodyText || (document.body ? document.body.innerText : '') || '';

      // 1. Exclude internal DMs & Group Chats view (left sidebar header says "DMs")
      const headerNodes = document.querySelectorAll('h1, h2, h3, h4, span, div, p');
      for (const el of headerNodes) {
        if (el.children.length === 0 && (el.textContent || '').trim() === 'DMs') {
          const r = el.getBoundingClientRect();
          if (r.left > 0 && r.left < 300 && r.top >= 0 && r.top < 100) {
            return false;
          }
        }
      }

      // 2. Require positive Visitor Chat UI markers on screen
      const hasWhisperOrSmartReply =
        text.includes('Whisper') || text.includes('Smart reply') || text.includes('Join Chat');
      const hasActiveVisitorsBar =
        /Active\s*\(\d+\)/.test(text) && text.includes('Visitors');
      const hasVisitorDetailsPanel =
        text.includes('ORGANIZATION') && text.includes('DEALS');

      return Boolean(hasWhisperOrSmartReply || hasActiveVisitorsBar || hasVisitorDetailsPanel);
    }

    bindAgentInteractions() {
      document.addEventListener(
        'keydown',
        (e) => {
          // Ignore keystrokes inside our own floating badge Shadow DOM
          if (this.badge && e.composedPath().includes(this.badge.host)) {
            return;
          }
          // Ignore keystrokes when chatting inside internal DMs / Group Chats
          if (!this.isVisitorChatContext()) {
            return;
          }
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

      const group = bubble?.parentElement?.parentElement || bubble?.parentElement || bubble;
      return { bubble, group };
    }

    scan() {
      if (this.badge) {
        this.badge.ensureInDOM();
      }

      const bodyText = (document.body ? document.body.innerText : '') || '';

      // Do NOT scan internal DMs or Group Chats — only scan Visitor Chats!
      if (!this.isVisitorChatContext(bodyText)) {
        state.detectedMessagesCount = 0;
        return;
      }

      // Visitor chat bubbles use AM/PM timestamps (e.g., "4:06 AM"), unlike DMs ("05:07")
      const timeRegex = /\b\d{1,2}:\d{2}\s*[AP]M\b/i;
      const allTextNodes = document.querySelectorAll('span, div, p, time, small, em');
      const messageItems = [];
      const seenBubbles = new Set();

      for (const el of allTextNodes) {
        if (el.children.length === 0) {
          const text = (el.textContent || '').trim();
          if (timeRegex.test(text) && text.length <= 12) {
            const rect = el.getBoundingClientRect();
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

      let lastSender = 'unknown';
      let lastText = '';
      let lastTimeStr = '';
      let visitorName = 'Visitor';

      for (let i = messageItems.length - 1; i >= 0; i--) {
        const { bubble, group, timeStr } = messageItems[i];
        const bubbleText = (bubble.innerText || '').trim();
        const groupText = (group ? group.innerText || '' : bubbleText).trim();
        const groupHTML = (group ? group.innerHTML || '' : '').toLowerCase();

        if (
          groupText.includes('(System Message)') ||
          bubbleText.includes('(System Message)') ||
          bubbleText.includes('has ended the chat')
        ) {
          continue;
        }

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

        if (bubbleText.length > 0) {
          lastSender = 'visitor';
          lastTimeStr = timeStr;

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

        if (state.msgKey === currentMsgKey && state.waitingSince) {
          return;
        }

        const parsedMsgTimestamp = parseMessageTime(lastTimeStr);
        const now = Date.now();
        const isInitialPageLoad = now - SCRIPT_START_TIME < 6000;

        if (parsedMsgTimestamp && (now - parsedMsgTimestamp >= 60 * 1000 || isInitialPageLoad)) {
          state.waitingSince = parsedMsgTimestamp;
        } else {
          state.waitingSince = now;
        }

        const initialElapsedSec = Math.floor((now - state.waitingSince) / 1000);
        state.msgKey = currentMsgKey;
        state.chimeFired = initialElapsedSec >= state.chimeThresholdSec;
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

        if (elapsedSec < state.chimeThresholdSec) {
          state.status = 'waiting';
          if (this.badge) this.badge.updateStatus('waiting', elapsedSec, state.lastVisitorMsgText);
        } else if (elapsedSec >= state.chimeThresholdSec && elapsedSec < state.urgentThresholdSec) {
          state.status = 'warning';
          if (this.badge) this.badge.updateStatus('warning', elapsedSec, state.lastVisitorMsgText);

          if (!state.chimeFired && shouldPlayAudioHere) {
            state.chimeFired = true;
            saveSharedState();
            audio.playChime();
          }
        } else if (elapsedSec >= state.urgentThresholdSec) {
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
    const subController = new TawkController(null);
    subController.start();
  }
})();
