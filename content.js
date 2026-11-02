/**
 * IR TickTawk - Chrome Extension Content Script (v1.3.0)
 * - 3-Chat Timebomb Stack ordered by deadline with « and » navigation arrows
 * - Clickable Urgent card & stacked timebomb rows that jump directly to that visitor's chat
 * - Default 1st Pre-Alarm Chime at 1:45 (105s) and Max Urgent Looping Alarm at 3:00 (180s)
 * - In-modal customizable alarm thresholds (Min & Sec)
 * - Strictly ignores internal Agent DMs, Group Chats, and old history (>15m)
 */

(() => {
  'use strict';

  const IS_TOP_FRAME = window === window.top;
  const IS_TAWK_DASHBOARD = window.location.hostname === 'dashboard.tawk.to';
  const SCRIPT_START_TIME = Date.now();
  const LOG_PREFIX = '[IR TickTawk]';

  if (!IS_TAWK_DASHBOARD) {
    return;
  }

  if (window.__IR_TICKTAWK_V130__) return;
  window.__IR_TICKTAWK_V130__ = true;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  // ==========================================
  // CONFIGURATION & DEFAULT THRESHOLDS
  // ==========================================
  const DEFAULT_CHIME_SEC = 105; // 1:45 (15s before 2m) pre-alarm chime
  const DEFAULT_URGENT_SEC = 180; // 3:00 (180s) max urgent looping alarm
  const MAX_INITIAL_MSG_AGE_MS = 15 * 60 * 1000; // Ignore history messages older than 15 mins
  const MAX_STACK_DISPLAY = 3; // Stack up to 3 timebomb chats in the queue UI
  const URGENT_LOOP_INTERVAL_MS = 1800;
  const STORAGE_STATE_KEY = 'ir_ticktawk_shared_state';
  const STORAGE_PREFS_KEY = 'ir_ticktawk_prefs';

  function formatShortTime(totalSec) {
    const m = Math.floor(totalSec / 60);
    const s = String(totalSec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function formatMMSS(totalSec) {
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // ==========================================
  // TIMESTAMP PARSER (Parses "4:06 AM" from visitor chat bubble)
  // ==========================================
  function parseMessageTime(timeStr) {
    if (!timeStr) return null;
    // Require AM/PM to avoid parsing arbitrary numbers or 24h DM timestamps as midnight
    const match = timeStr.trim().match(/\b(\d{1,2}):(\d{2})\s*([AP]M)\b/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const meridiem = match[3].toUpperCase();

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
        { freq: 659.25, time: 0.00, dur: 0.35, gain: 0.25 },
        { freq: 880.00, time: 0.16, dur: 0.45, gain: 0.30 },
        { freq: 1318.51, time: 0.35, dur: 0.80, gain: 0.35 }
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
  // SHARED STATE & MULTI-CHAT TIMEBOMB QUEUE
  // ==========================================
  const state = {
    chats: [], // Array of { id, visitorName, msgText, timeStr, msgKey, waitingSince, chimeFired, urgentFired, silenced, chatUrlHash }
    selectedIndex: 0,
    transientStatus: null, // 'replied' | 'ended' | null
    detectedMessagesCount: 0,
    isMinimized: false,
    isMuted: false,
    pos: null,
    chimeThresholdSec: DEFAULT_CHIME_SEC,
    urgentThresholdSec: DEFAULT_URGENT_SEC
  };

  const audio = new AudioManager();

  /**
   * Sorts waiting chats by deadline: oldest waitingSince (longest wait / closest to deadline) first.
   */
  function sortChatsByDeadline() {
    state.chats.sort((a, b) => a.waitingSince - b.waitingSince);
    if (state.selectedIndex >= state.chats.length) {
      state.selectedIndex = Math.max(0, state.chats.length - 1);
    }
  }

  function upsertChat(chatData) {
    const existingIdx = state.chats.findIndex((c) => c.id === chatData.id);
    if (existingIdx !== -1) {
      const existing = state.chats[existingIdx];
      // If the exact same visitor message is already tracked, keep its waitingSince!
      if (existing.msgKey === chatData.msgKey && existing.waitingSince) {
        existing.chatUrlHash = chatData.chatUrlHash || existing.chatUrlHash;
        return false;
      }
      // Otherwise update with new message for this visitor
      state.chats[existingIdx] = {
        ...existing,
        ...chatData
      };
    } else {
      state.chats.push(chatData);
    }
    sortChatsByDeadline();
    return true;
  }

  function removeChatById(id) {
    const beforeLen = state.chats.length;
    state.chats = state.chats.filter((c) => c.id !== id);
    sortChatsByDeadline();
    if (state.chats.length === 0) {
      audio.stopUrgentAlarm();
    } else {
      // Stop alarm if no remaining chat is unsilenced urgent
      const now = Date.now();
      const anyUrgentUnsilenced = state.chats.some(
        (c) => !c.silenced && Math.floor((now - c.waitingSince) / 1000) >= state.urgentThresholdSec
      );
      if (!anyUrgentUnsilenced) {
        audio.stopUrgentAlarm();
      }
    }
    return state.chats.length !== beforeLen;
  }

  function saveSharedState() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local
      .set({
        [STORAGE_STATE_KEY]: {
          schemaVersion: 3,
          chats: state.chats,
          selectedIndex: state.selectedIndex,
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
          if (s.schemaVersion === 3 && Array.isArray(s.chats)) {
            // Filter out any stale chats older than 30 minutes
            const now = Date.now();
            state.chats = s.chats.filter(
              (c) => c && c.waitingSince && now - c.waitingSince < 30 * 60 * 1000
            );
            state.selectedIndex = s.selectedIndex || 0;
            state.detectedMessagesCount = s.detectedMessagesCount || 0;
            sortChatsByDeadline();
          } else {
            // Purge old schema state (e.g. stale 321:03 entry)
            state.chats = [];
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
          if (
            typeof p.urgentThresholdSec === 'number' &&
            p.urgentThresholdSec > state.chimeThresholdSec
          ) {
            state.urgentThresholdSec = p.urgentThresholdSec;
          }
        }
        resolve();
      });
    });
  }

  // ==========================================
  // CLICK-TO-JUMP CHAT NAVIGATOR
  // ==========================================
  function jumpToVisitorChat(chat) {
    if (!chat) return;
    log('Jumping to visitor chat:', chat.visitorName, chat.msgText);

    const targetName = (chat.visitorName || '').trim().toLowerCase();
    const targetSnippet = (chat.msgText || '').slice(0, 20).trim().toLowerCase();

    // 1. Search clickable items in the left Active sidebar or collapsed multi-chat stack cards
    const candidates = document.querySelectorAll(
      'a, button, [role="button"], li, tr, div[class*="item"], div[class*="card"], div[class*="row"], div[class*="chat"]'
    );

    let bestMatch = null;

    for (const el of candidates) {
      if (el.id === 'ir-ticktawk-root') continue;
      const rect = el.getBoundingClientRect();
      // Look in the left sidebar or collapsed chat stack (left < 400px, reasonable height)
      if (rect.width > 40 && rect.height >= 24 && rect.height <= 120 && rect.left < 420) {
        const text = (el.innerText || '').trim().toLowerCase();
        if (
          (targetName && targetName !== 'visitor' && text.includes(targetName)) ||
          (targetSnippet && targetSnippet.length > 3 && text.includes(targetSnippet))
        ) {
          bestMatch = el;
          break;
        }
      }
    }

    if (bestMatch) {
      bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
      bestMatch.click();
      // Also click first child or parent if needed by Vue router/handlers
      if (bestMatch.firstElementChild) {
        bestMatch.firstElementChild.click();
      }
    } else if (chat.chatUrlHash && window.location.hash !== chat.chatUrlHash) {
      window.location.hash = chat.chatUrlHash;
    }

    // 2. Highlight the active chat panel and focus the reply input box
    setTimeout(() => {
      const inputs = document.querySelectorAll('textarea, [contenteditable="true"]');
      for (const inp of inputs) {
        const r = inp.getBoundingClientRect();
        if (r.width > 100 && r.height > 15) {
          inp.focus();
          const panel = inp.closest('div[class*="chat"], div[class*="panel"]') || inp.parentElement;
          if (panel) {
            panel.style.transition = 'box-shadow 0.3s ease';
            panel.style.boxShadow = '0 0 0 3px #ef4444';
            setTimeout(() => {
              panel.style.boxShadow = '';
            }, 1400);
          }
          break;
        }
      }
    }, 150);
  }

  // ==========================================
  // DRAGGABLE FLOATING BADGE UI (3-Chat Stack + « / » Nav)
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
      this.simCounter = 1;
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
              <span class="tt-queue-pill" id="tt-queue-pill" style="display:none;">0</span>
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
            <!-- « and » Navigation Bar for Queued Timebomb Chats -->
            <div class="tt-nav-bar" id="tt-nav-bar" style="display:none;">
              <button class="tt-nav-btn" id="tt-nav-prev" title="Previous Waiting Chat">&laquo;</button>
              <div class="tt-nav-title" id="tt-nav-title">💣 Timebomb 1 of 1</div>
              <button class="tt-nav-btn" id="tt-nav-next" title="Next Waiting Chat">&raquo;</button>
            </div>

            <!-- Clickable Main Active Chat Display -->
            <div class="tt-main-card" id="tt-main-card" title="Click to jump to this visitor's chat">
              <div class="tt-timer-row">
                <div class="tt-timer" id="tt-timer">00:00</div>
                <div class="tt-status-badge" id="tt-badge-tag">Idle</div>
              </div>
              <div class="tt-desc-row">
                <div class="tt-desc" id="tt-desc">Monitoring visitor chats...</div>
                <span class="tt-jump-hint" id="tt-jump-hint" style="display:none;">Open ↗</span>
              </div>
            </div>

            <!-- Stacked 3-Timebomb List (Sorted by Urgency / Deadline) -->
            <div class="tt-stack-list" id="tt-stack-list" style="display:none;"></div>

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
              <button class="tt-action-btn" id="tt-btn-sim" title="Advance wait timer by +1m">+1m Sim</button>
              <button class="tt-action-btn" id="tt-btn-add-bomb" title="Add simulated timebomb chat to test 3-stack">+ Bomb</button>
              <button class="tt-action-btn" id="tt-btn-reset" title="Clear all timers">Clear All</button>
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
        queuePill: this.shadow.getElementById('tt-queue-pill'),
        miniTimer: this.shadow.getElementById('tt-mini-timer'),
        navBar: this.shadow.getElementById('tt-nav-bar'),
        navPrev: this.shadow.getElementById('tt-nav-prev'),
        navTitle: this.shadow.getElementById('tt-nav-title'),
        navNext: this.shadow.getElementById('tt-nav-next'),
        mainCard: this.shadow.getElementById('tt-main-card'),
        timer: this.shadow.getElementById('tt-timer'),
        badgeTag: this.shadow.getElementById('tt-badge-tag'),
        desc: this.shadow.getElementById('tt-desc'),
        jumpHint: this.shadow.getElementById('tt-jump-hint'),
        stackList: this.shadow.getElementById('tt-stack-list'),
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
        btnAddBomb: this.shadow.getElementById('tt-btn-add-bomb'),
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
          padding: 12px 15px;
          min-width: 300px;
          max-width: 360px;
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
        }
        .tt-queue-pill {
          background: #ef4444;
          color: #ffffff;
          font-size: 10px;
          font-weight: 800;
          padding: 1px 6px;
          border-radius: 10px;
        }
        .tt-status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #10b981;
          display: inline-block;
          flex-shrink: 0;
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
          gap: 6px;
        }
        .tt-badge.minimized .tt-body {
          display: none;
        }
        /* « and » Carousel Nav Bar */
        .tt-nav-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          padding: 3px 6px;
        }
        .tt-nav-btn {
          background: rgba(255, 255, 255, 0.1);
          border: none;
          color: #ffffff;
          font-size: 14px;
          font-weight: 800;
          line-height: 1;
          padding: 3px 9px;
          border-radius: 5px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .tt-nav-btn:hover {
          background: rgba(59, 130, 246, 0.6);
        }
        .tt-nav-title {
          font-size: 11px;
          font-weight: 700;
          color: #e5e7eb;
          letter-spacing: 0.2px;
        }
        /* Clickable Main Card */
        .tt-main-card {
          padding: 6px 8px;
          border-radius: 9px;
          border: 1px solid transparent;
          transition: all 0.15s;
        }
        .tt-main-card.clickable {
          cursor: pointer;
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.1);
        }
        .tt-main-card.clickable:hover {
          background: rgba(59, 130, 246, 0.15);
          border-color: rgba(59, 130, 246, 0.5);
        }
        .tt-main-card.urgent-card {
          background: rgba(239, 68, 68, 0.14);
          border-color: rgba(239, 68, 68, 0.45);
        }
        .tt-main-card.urgent-card:hover {
          background: rgba(239, 68, 68, 0.24);
          border-color: rgba(239, 68, 68, 0.8);
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
        .tt-desc-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          margin-top: 2px;
        }
        .tt-desc {
          font-size: 12px;
          color: #d1d5db;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }
        .tt-jump-hint {
          font-size: 10px;
          font-weight: 700;
          color: #93c5fd;
          background: rgba(59, 130, 246, 0.2);
          padding: 2px 6px;
          border-radius: 5px;
          flex-shrink: 0;
        }
        /* Stacked 3-Timebomb Queue List */
        .tt-stack-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-top: 2px;
        }
        .tt-stack-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 5px 8px;
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          cursor: pointer;
          font-size: 11px;
          transition: all 0.15s;
        }
        .tt-stack-item:hover {
          background: rgba(59, 130, 246, 0.18);
          border-color: rgba(59, 130, 246, 0.5);
        }
        .tt-stack-item.active {
          border-color: #60a5fa;
          background: rgba(59, 130, 246, 0.14);
        }
        .tt-stack-item.urgent {
          background: rgba(239, 68, 68, 0.18);
          border-color: rgba(239, 68, 68, 0.5);
        }
        .tt-stack-item.warning {
          background: rgba(249, 115, 22, 0.15);
          border-color: rgba(249, 115, 22, 0.45);
        }
        .tt-stack-left {
          display: flex;
          align-items: center;
          gap: 6px;
          overflow: hidden;
          flex: 1;
        }
        .tt-stack-name {
          font-weight: 700;
          color: #ffffff;
          flex-shrink: 0;
        }
        .tt-stack-msg {
          color: #9ca3af;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .tt-stack-right {
          display: flex;
          align-items: center;
          gap: 5px;
          flex-shrink: 0;
        }
        .tt-stack-time {
          font-family: ui-monospace, SFMono-Regular, monospace;
          font-weight: 800;
          font-size: 11px;
          padding: 1px 5px;
          border-radius: 4px;
          background: rgba(0, 0, 0, 0.35);
          color: #f3f4f6;
        }
        .tt-stack-dismiss {
          background: transparent;
          border: none;
          color: rgba(255, 255, 255, 0.45);
          cursor: pointer;
          font-size: 11px;
          padding: 1px 4px;
          border-radius: 4px;
        }
        .tt-stack-dismiss:hover {
          background: rgba(239, 68, 68, 0.4);
          color: #ffffff;
        }
        /* Settings Panel */
        .tt-settings-panel {
          margin-top: 4px;
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
          margin-top: 4px;
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
        .tt-action-btn.silence {
          background: #ef4444;
          border-color: #dc2626;
          color: #ffffff;
          font-weight: 700;
        }
        .tt-audio-status {
          margin-top: 4px;
          font-size: 11px;
          padding: 4px 8px;
          border-radius: 6px;
          text-align: center;
          cursor: pointer;
          font-weight: 600;
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
      const w = rect.width || 305;
      const h = rect.height || 180;
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
        if (
          path.some(
            (el) =>
              el &&
              (el.tagName === 'BUTTON' ||
                el.tagName === 'INPUT' ||
                el.id === 'tt-settings-panel' ||
                el.id === 'tt-stack-list' ||
                (el.id === 'tt-main-card' && state.chats.length > 0))
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
          width: 340,
          height: 310
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

      // « Previous Timebomb Chat
      this.elements.navPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.chats.length === 0) return;
        state.selectedIndex =
          (state.selectedIndex - 1 + state.chats.length) % state.chats.length;
        saveSharedState();
        this.renderQueue();
      });

      // » Next Timebomb Chat
      this.elements.navNext.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.chats.length === 0) return;
        state.selectedIndex = (state.selectedIndex + 1) % state.chats.length;
        saveSharedState();
        this.renderQueue();
      });

      // Clickable Main Card -> Jump to selected visitor's chat
      this.elements.mainCard.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.chats.length === 0) return;
        const selectedChat = state.chats[state.selectedIndex] || state.chats[0];
        if (selectedChat) {
          jumpToVisitorChat(selectedChat);
        }
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

      this.elements.btnSaveSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        this.saveThresholdSettings();
      });

      this.elements.btnDefaultSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        state.chimeThresholdSec = DEFAULT_CHIME_SEC;
        state.urgentThresholdSec = DEFAULT_URGENT_SEC;
        this.syncThresholdInputsAndLabels();
        savePrefs();
        this.flashSavedFeedback();
      });

      this.elements.btnPip.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.togglePiP();
      });

      this.elements.btnMute.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        state.isMuted = !state.isMuted;
        audio.setMuted(state.isMuted);
        this.updateMuteIcon();
        savePrefs();
      });

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

      this.elements.btnTestChime.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();
        audio.playChime();
      });

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

      // Silence Alarm for all currently urgent chats
      this.elements.btnSilence.addEventListener('click', (e) => {
        e.stopPropagation();
        audio.stopUrgentAlarm();
        state.chats.forEach((c) => {
          c.silenced = true;
        });
        this.elements.btnSilence.style.display = 'none';
        this.elements.btnTestAlarm.textContent = `Test ${formatShortTime(
          state.urgentThresholdSec
        )} Alarm`;
        saveSharedState();
      });

      // +1m Sim on selected chat (or creates 1 if empty)
      this.elements.btnSim.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();

        if (state.chats.length === 0) {
          upsertChat({
            id: 'Sim Visitor 1',
            visitorName: 'Sim Visitor 1',
            msgText: 'Need help with order status please',
            timeStr: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
            msgKey: `sim-1-${Date.now()}`,
            waitingSince: Date.now() - 60 * 1000,
            chimeFired: false,
            urgentFired: false,
            silenced: false,
            chatUrlHash: window.location.hash
          });
        } else {
          const target = state.chats[state.selectedIndex] || state.chats[0];
          target.waitingSince -= 60 * 1000;
          sortChatsByDeadline();
        }
        saveSharedState();
        this.renderQueue();
      });

      // + Bomb: Add another simulated waiting visitor to test the 3-Timebomb Stack & « / » nav
      this.elements.btnAddBomb.addEventListener('click', async (e) => {
        e.stopPropagation();
        await audio.ensureResumed();
        this.updateAudioIndicator();

        this.simCounter = (state.chats.length % 3) + 1;
        const names = ['Joe', 'Sarah', 'Alex'];
        const msgs = [
          'who let the dawgs out woof woo',
          'Is anyone available to assist?',
          'Checking on my account upgrade'
        ];
        const idx = state.chats.length % 3;
        const name = `${names[idx]} #${state.chats.length + 1}`;
        const randomOffsetSec = 45 + state.chats.length * 40;

        upsertChat({
          id: name,
          visitorName: name,
          msgText: msgs[idx],
          timeStr: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          msgKey: `${name}-${Date.now()}`,
          waitingSince: Date.now() - randomOffsetSec * 1000,
          chimeFired: false,
          urgentFired: false,
          silenced: false,
          chatUrlHash: window.location.hash
        });
        saveSharedState();
        this.renderQueue();
      });

      // Clear All timers
      this.elements.btnReset.addEventListener('click', (e) => {
        e.stopPropagation();
        audio.stopUrgentAlarm();
        state.chats = [];
        state.selectedIndex = 0;
        state.transientStatus = null;
        this.elements.btnSilence.style.display = 'none';
        this.elements.btnTestAlarm.textContent = `Test ${formatShortTime(
          state.urgentThresholdSec
        )} Alarm`;
        saveSharedState();
        this.renderQueue();
      });

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

      const chimeTotal = Math.max(5, cMin * 60 + cSec);
      let urgentTotal = uMin * 60 + uSec;

      if (urgentTotal <= chimeTotal) {
        urgentTotal = chimeTotal + 15;
      }

      state.chimeThresholdSec = chimeTotal;
      state.urgentThresholdSec = urgentTotal;

      this.syncThresholdInputsAndLabels();
      savePrefs();
      this.flashSavedFeedback();
      this.renderQueue();
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

    getChatLevel(elapsedSec) {
      if (elapsedSec >= state.urgentThresholdSec) return 'urgent';
      if (elapsedSec >= state.chimeThresholdSec) return 'warning';
      return 'waiting';
    }

    /**
     * Renders the « / » navigation bar, clickable main card, and top-3 stacked timebomb rows.
     */
    renderQueue() {
      const now = Date.now();
      const chimeStr = formatShortTime(state.chimeThresholdSec);
      const urgentStr = formatShortTime(state.urgentThresholdSec);

      sortChatsByDeadline();
      const totalWaiting = state.chats.length;

      // Update header queue count pill
      if (totalWaiting > 0) {
        this.elements.queuePill.style.display = 'inline-block';
        this.elements.queuePill.textContent = `${totalWaiting}`;
      } else {
        this.elements.queuePill.style.display = 'none';
      }

      // If no chats are waiting, show Idle / Replied / Ended state
      if (totalWaiting === 0) {
        this.elements.navBar.style.display = 'none';
        this.elements.stackList.style.display = 'none';
        this.elements.mainCard.className = 'tt-main-card';
        this.elements.jumpHint.style.display = 'none';
        this.elements.timer.textContent = '00:00';
        this.elements.miniTimer.textContent = '--:--';
        this.elements.btnSilence.style.display = 'none';

        const status = state.transientStatus || 'idle';
        this.elements.dot.className = `tt-status-dot ${status}`;
        this.elements.badgeTag.className = `tt-status-badge ${status}`;

        if (status === 'replied') {
          this.elements.badgeTag.textContent = 'Replied';
          this.elements.desc.textContent = 'Agent replied! Timer cleared.';
        } else if (status === 'ended') {
          this.elements.badgeTag.textContent = 'Ended';
          this.elements.desc.textContent = 'Visitor ended chat.';
        } else {
          this.elements.badgeTag.textContent = 'Idle';
          this.elements.desc.textContent = `Pre-alarm ${chimeStr} · Max ${urgentStr} (${state.detectedMessagesCount} msgs)`;
        }
        this.updateAudioIndicator();
        return;
      }

      // Show « / » navigation bar when 1 or more timebomb chats are active
      const selIdx = Math.min(state.selectedIndex, totalWaiting - 1);
      const selectedChat = state.chats[selIdx];
      const selElapsed = Math.max(0, Math.floor((now - selectedChat.waitingSince) / 1000));
      const selLevel = this.getChatLevel(selElapsed);

      // Highest urgency across ALL queued chats drives the top status dot
      const mostUrgentElapsed = Math.max(
        0,
        Math.floor((now - state.chats[0].waitingSince) / 1000)
      );
      const highestLevel = this.getChatLevel(mostUrgentElapsed);
      this.elements.dot.className = `tt-status-dot ${highestLevel}`;
      this.elements.miniTimer.textContent = formatMMSS(mostUrgentElapsed);

      // Render « and » navigation header
      this.elements.navBar.style.display = 'flex';
      this.elements.navTitle.textContent = `💣 Timebomb ${selIdx + 1} of ${totalWaiting} — ${selectedChat.visitorName}`;

      // Render Clickable Main Card for selected chat
      this.elements.mainCard.className = `tt-main-card clickable ${
        selLevel === 'urgent' ? 'urgent-card' : ''
      }`;
      this.elements.jumpHint.style.display = 'inline-block';
      this.elements.timer.textContent = formatMMSS(selElapsed);
      this.elements.badgeTag.className = `tt-status-badge ${selLevel}`;

      const timeSuffix = selectedChat.timeStr ? ` (${selectedChat.timeStr})` : '';
      if (selLevel === 'urgent') {
        this.elements.badgeTag.textContent = `${urgentStr} URGENT!`;
        this.elements.desc.textContent = `URGENT > ${urgentStr}${timeSuffix}: "${selectedChat.msgText}"`;
      } else if (selLevel === 'warning') {
        this.elements.badgeTag.textContent = `${chimeStr} PRE-ALARM`;
        this.elements.desc.textContent = `Pre-Alarm > ${chimeStr}${timeSuffix}: "${selectedChat.msgText}"`;
      } else {
        this.elements.badgeTag.textContent = 'WAITING';
        this.elements.desc.textContent = `${selectedChat.visitorName}${timeSuffix}: "${selectedChat.msgText}"`;
      }

      // Show Silence button if any chat is ringing urgent alarm
      if (audio.isUrgentLooping) {
        this.elements.btnSilence.style.display = 'inline-block';
      }

      // Render Stacked Top-3 Timebomb List
      const topThree = state.chats.slice(0, MAX_STACK_DISPLAY);
      this.elements.stackList.style.display = 'flex';
      this.elements.stackList.innerHTML = '';

      topThree.forEach((chat, idx) => {
        const cElapsed = Math.max(0, Math.floor((now - chat.waitingSince) / 1000));
        const cLevel = this.getChatLevel(cElapsed);
        const icon = cLevel === 'urgent' ? '💣' : cLevel === 'warning' ? '⚠️' : '⏳';

        const row = document.createElement('div');
        row.className = `tt-stack-item ${cLevel} ${idx === selIdx ? 'active' : ''}`;
        row.title = `Click to open ${chat.visitorName}'s chat`;

        const left = document.createElement('div');
        left.className = 'tt-stack-left';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tt-stack-name';
        nameSpan.textContent = `${icon} ${idx + 1}. ${chat.visitorName}`;

        const msgSpan = document.createElement('span');
        msgSpan.className = 'tt-stack-msg';
        msgSpan.textContent = chat.msgText ? `— "${chat.msgText}"` : '';

        left.appendChild(nameSpan);
        left.appendChild(msgSpan);

        const right = document.createElement('div');
        right.className = 'tt-stack-right';

        const timeBadge = document.createElement('span');
        timeBadge.className = 'tt-stack-time';
        timeBadge.textContent = formatMMSS(cElapsed);

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'tt-stack-dismiss';
        dismissBtn.textContent = '✕';
        dismissBtn.title = 'Dismiss from queue';
        dismissBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          removeChatById(chat.id);
          saveSharedState();
          this.renderQueue();
        });

        right.appendChild(timeBadge);
        right.appendChild(dismissBtn);

        row.appendChild(left);
        row.appendChild(right);

        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.selectedIndex = idx;
          saveSharedState();
          this.renderQueue();
          jumpToVisitorChat(chat);
        });

        this.elements.stackList.appendChild(row);
      });

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
        this.badge.renderQueue();
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
          if (s.schemaVersion === 3 && Array.isArray(s.chats)) {
            state.chats = s.chats;
            state.selectedIndex = s.selectedIndex || 0;
            state.detectedMessagesCount = s.detectedMessagesCount || 0;
            sortChatsByDeadline();

            const now = Date.now();
            const anyUrgentUnsilenced = state.chats.some(
              (c) =>
                !c.silenced &&
                Math.floor((now - c.waitingSince) / 1000) >= state.urgentThresholdSec
            );
            if (!anyUrgentUnsilenced) {
              audio.stopUrgentAlarm();
            }
            if (this.badge) this.badge.renderQueue();
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
            this.badge.renderQueue();
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

    /**
     * Extracts the active visitor's name from the top chat panel header (e.g. "Joe - ivantawkdev" -> "Joe").
     */
    getActiveChatHeaderVisitorName() {
      const candidates = document.querySelectorAll('h1, h2, h3, h4, span, div');
      for (const el of candidates) {
        if (el.children.length === 0) {
          const text = (el.textContent || '').trim();
          if (text.includes(' - ') && text.length < 50) {
            const r = el.getBoundingClientRect();
            if (r.left > 150 && r.top > 40 && r.top < 140) {
              return text.split(' - ')[0].trim();
            }
          }
        }
      }
      return null;
    }

    bindAgentInteractions() {
      document.addEventListener(
        'keydown',
        (e) => {
          if (this.badge && e.composedPath().includes(this.badge.host)) {
            return;
          }
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
                const activeVisitor =
                  this.getActiveChatHeaderVisitorName() ||
                  (state.chats[state.selectedIndex] &&
                    state.chats[state.selectedIndex].visitorName);
                log('Agent pressed Enter to reply to:', activeVisitor || 'active chat');
                this.onAgentReplied(activeVisitor);
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
      const timeRegexGlobal = /\b\d{1,2}:\d{2}\s*[AP]M\b/gi;

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

      if (!this.isVisitorChatContext(bodyText)) {
        state.detectedMessagesCount = 0;
        return;
      }

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

      const headerVisitorName = this.getActiveChatHeaderVisitorName();

      if (bodyText.includes('has ended the chat') || bodyText.includes('chat has ended')) {
        const lastBubble = messageItems[messageItems.length - 1].bubble;
        const lastBubbleText = (lastBubble.innerText || '').trim();
        const endedIdx = bodyText.lastIndexOf('ended the chat');
        const bubbleIdx = bodyText.lastIndexOf(lastBubbleText);
        if (endedIdx > bubbleIdx) {
          if (headerVisitorName) {
            removeChatById(headerVisitorName);
          }
          state.transientStatus = 'ended';
          saveSharedState();
          if (this.badge) this.badge.renderQueue();
          return;
        }
      }

      let lastSender = 'unknown';
      let lastText = '';
      let lastTimeStr = '';
      let visitorName = headerVisitorName || 'Visitor';

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
          lastText = bubbleText.replace(/\b\d{1,2}:\d{2}\s*[AP]M\b/gi, '').trim();
          lastTimeStr = timeStr;
          break;
        }

        if (bubbleText.length > 0) {
          lastSender = 'visitor';
          lastTimeStr = timeStr;

          if (!headerVisitorName) {
            const groupLines = groupText
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
            if (
              groupLines.length > 1 &&
              groupLines[0].length <= 25 &&
              !groupLines[0].includes(':')
            ) {
              visitorName = groupLines[0];
            }
          }

          lastText = bubbleText
            .replace(/\b\d{1,2}:\d{2}\s*[AP]M\b/gi, '')
            .replace(new RegExp(`^${visitorName}\\s*`, 'i'), '')
            .trim();
          break;
        }
      }

      if (lastSender === 'agent') {
        if (visitorName && removeChatById(visitorName)) {
          log('Agent replied to:', visitorName);
          this.onAgentReplied(visitorName);
        }
      } else if (lastSender === 'visitor') {
        const parsedMsgTimestamp = parseMessageTime(lastTimeStr);
        const now = Date.now();

        // Ignore old chat history (> 15 minutes old) so archived messages don't show 321:03
        if (parsedMsgTimestamp && now - parsedMsgTimestamp > MAX_INITIAL_MSG_AGE_MS) {
          return;
        }

        const currentMsgKey = `${visitorName}|${lastTimeStr}|${lastText}`;
        const isInitialPageLoad = now - SCRIPT_START_TIME < 6000;

        let waitingSince = now;
        if (parsedMsgTimestamp && (now - parsedMsgTimestamp >= 60 * 1000 || isInitialPageLoad)) {
          waitingSince = parsedMsgTimestamp;
        }

        const initialElapsedSec = Math.floor((now - waitingSince) / 1000);
        const changed = upsertChat({
          id: visitorName,
          visitorName,
          msgText: lastText,
          timeStr: lastTimeStr,
          msgKey: currentMsgKey,
          waitingSince,
          chimeFired: initialElapsedSec >= state.chimeThresholdSec,
          urgentFired: false,
          silenced: false,
          chatUrlHash: window.location.hash
        });

        if (changed) {
          state.transientStatus = null;
          saveSharedState();
          if (this.badge) this.badge.renderQueue();
        }
      }
    }

    onAgentReplied(visitorName) {
      if (visitorName) {
        removeChatById(visitorName);
      } else if (state.chats.length > 0) {
        const sel = state.chats[state.selectedIndex] || state.chats[0];
        if (sel) removeChatById(sel.id);
      }

      state.transientStatus = 'replied';
      saveSharedState();

      if (this.badge) {
        this.badge.renderQueue();
      }

      setTimeout(() => {
        if (state.transientStatus === 'replied') {
          state.transientStatus = null;
          if (this.badge) this.badge.renderQueue();
        }
      }, 3500);
    }

    startTimerTick() {
      clearInterval(this.tickInterval);
      this.tickInterval = setInterval(() => {
        if (state.chats.length === 0) {
          if (this.badge) this.badge.renderQueue();
          return;
        }

        const now = Date.now();
        const shouldPlayAudioHere = IS_TAWK_DASHBOARD || document.visibilityState === 'visible';
        let stateMutated = false;

        for (const chat of state.chats) {
          const elapsedSec = Math.max(0, Math.floor((now - chat.waitingSince) / 1000));

          if (
            elapsedSec >= state.chimeThresholdSec &&
            elapsedSec < state.urgentThresholdSec &&
            !chat.chimeFired
          ) {
            chat.chimeFired = true;
            stateMutated = true;
            if (shouldPlayAudioHere) {
              audio.playChime();
            }
          } else if (elapsedSec >= state.urgentThresholdSec && !chat.silenced) {
            if (!chat.urgentFired) {
              chat.urgentFired = true;
              stateMutated = true;
            }
            if (shouldPlayAudioHere && !audio.isUrgentLooping) {
              audio.startUrgentAlarm();
            }
          }
        }

        if (stateMutated) {
          saveSharedState();
        }

        if (this.badge) {
          this.badge.renderQueue();
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
