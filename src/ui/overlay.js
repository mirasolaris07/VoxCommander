'use strict';

/**
 * ui/overlay.js — HUD renderer.
 *
 * Phase 2, Step 27.
 *
 * Handles stateChange events and renders the appropriate HUD view.
 * Dictation states covered:
 *   idle · recording · transcribing · typed · error
 *
 * All OS calls go through window.typelessAPI — never ipcRenderer directly.
 */

/* global typelessAPI */

const hud = document.getElementById('hud');

// ── State ──────────────────────────────────────────────────────────────────────

let _idleFadeTimer  = null;
let _typedFadeTimer = null;
let _timerInterval  = null;
let _recordingStart = null;
let _dictateKey     = 'Ctrl+Space';
let _planKey        = 'Ctrl+Shift+Space';

// ── Render helpers ─────────────────────────────────────────────────────────────

function pill(extraClass, ...children) {
  const div = document.createElement('div');
  div.className = `pill${extraClass ? ' ' + extraClass : ''}`;
  children.forEach((c) => {
    if (typeof c === 'string') {
      const span = document.createElement('span');
      span.className = 'label';
      span.textContent = c;
      div.appendChild(span);
    } else if (c) {
      div.appendChild(c);
    }
  });
  return div;
}

function waveform(color = '') {
  const div = document.createElement('div');
  div.className = `waveform${color ? ' ' + color : ''}`;
  for (let i = 0; i < 5; i++) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    div.appendChild(bar);
  }
  return div;
}

function dot(color) {
  const d = document.createElement('div');
  d.className = `dot ${color}`;
  return d;
}

function spinner() {
  const d = document.createElement('div');
  d.className = 'spinner';
  return d;
}

function timerEl() {
  const span = document.createElement('span');
  span.className = 'timer';
  span.id = 'rec-timer';
  span.textContent = '0:00';
  return span;
}

function undoBtn() {
  const btn = document.createElement('button');
  btn.className = 'undo-btn';
  btn.textContent = '↺ Undo';
  btn.addEventListener('click', () => typelessAPI.requestUndo());
  return btn;
}

function formatSeconds(sec) {
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ── Clear timers ────────────────────────────────────────────────────────────────

function _clearTimers() {
  if (_idleFadeTimer)  { clearTimeout(_idleFadeTimer);  _idleFadeTimer  = null; }
  if (_typedFadeTimer) { clearTimeout(_typedFadeTimer); _typedFadeTimer = null; }
  if (_timerInterval)  { clearInterval(_timerInterval); _timerInterval  = null; }
  _recordingStart = null;
}

// ── State renderers ─────────────────────────────────────────────────────────────

function renderIdle() {
  _clearTimers();
  hud.innerHTML = '';

  const hint = document.createElement('div');
  hint.className = 'hint';

  const k1 = document.createElement('span');
  k1.className = 'kbd'; k1.textContent = _dictateKey;

  const sep = document.createElement('span');
  sep.className = 'label'; sep.textContent = 'dictate';

  hint.appendChild(k1);
  hint.appendChild(sep);

  const p = pill('', hint);
  hud.appendChild(p);

  _idleFadeTimer = setTimeout(() => {
    p.classList.add('fade');
  }, 5000);
}

function renderRecording(mode) {
  _clearTimers();
  hud.innerHTML = '';

  const color = mode === 'plan' ? 'amber' : '';
  _recordingStart = Date.now();

  const timer = timerEl();
  const p = pill('', waveform(color), timer);
  hud.appendChild(p);

  _timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - _recordingStart) / 1000);
    const el = document.getElementById('rec-timer');
    if (el) el.textContent = formatSeconds(elapsed);
  }, 1000);
}

function renderTranscribing() {
  _clearTimers();
  hud.innerHTML = '';
  const p = pill('', spinner(), 'Transcribing…');
  hud.appendChild(p);
}

function renderTyped(data) {
  _clearTimers();
  hud.innerHTML = '';

  const preview = document.createElement('span');
  preview.className = 'preview';
  preview.textContent = (data && data.text) ? `"${data.text}"` : 'Typed ✓';

  const p = pill('', dot('green'), preview, undoBtn());
  hud.appendChild(p);

  // Auto-dismiss after 2 s
  _typedFadeTimer = setTimeout(() => {
    hud.innerHTML = '';
    renderIdle();
  }, 2000);
}

function renderError(data) {
  _clearTimers();
  hud.innerHTML = '';

  const msg = document.createElement('span');
  msg.className = 'error-msg';
  msg.textContent = (data && data.message) ? data.message : 'An error occurred';

  const p = pill('error-state', dot('red'), msg);
  hud.appendChild(p);

  // Auto-dismiss error after 4 s
  setTimeout(() => renderIdle(), 4000);
}

function renderRateLimited(data) {
  _clearTimers();
  hud.innerHTML = '';

  const msg = document.createElement('span');
  msg.className = 'label';
  msg.textContent = 'Rate limited — retrying…';

  const p = pill('', dot('amber'), msg);
  hud.appendChild(p);
}

// ── State machine ───────────────────────────────────────────────────────────────

function applyState(state, data) {
  switch (state) {
    case 'idle':          renderIdle();           break;
    case 'recording':     renderRecording(data && data.mode); break;
    case 'transcribing':  renderTranscribing();   break;
    case 'typed':         renderTyped(data);      break;
    case 'error':         renderError(data);      break;
    case 'rateLimited':   renderRateLimited(data);break;
    // Plan states (Phase 3) — show processing pill as placeholder
    case 'planning':
    case 'executing':
      hud.innerHTML = '';
      hud.appendChild(pill('', spinner(), state === 'planning' ? 'Planning…' : 'Executing…'));
      break;
    default:
      // Unknown state — stay as-is
      break;
  }
}

// ── IPC listeners ───────────────────────────────────────────────────────────────

typelessAPI.onStateChange((state) => {
  applyState(state, null);
});

typelessAPI.onError((data) => {
  applyState('error', data);
});

typelessAPI.onUndoAvailable((data) => {
  // If HUD is showing typed state, ensure undo button is visible
  if (data && data.available) {
    const existing = document.querySelector('.undo-btn');
    if (!existing) {
      const btn = undoBtn();
      const p   = document.querySelector('.pill');
      if (p) p.appendChild(btn);
    }
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────────

// Fetch hotkeys from config then render — fall back to defaults if IPC fails
typelessAPI.getConfig().then((cfg) => {
  if (cfg && cfg.hotkey) {
    _dictateKey = cfg.hotkey.dictate || 'Ctrl+Space';
    _planKey    = cfg.hotkey.plan    || 'Ctrl+Shift+Space';
  }
  renderIdle();
}).catch(() => {
  renderIdle();
});
