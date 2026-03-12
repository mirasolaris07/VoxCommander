'use strict';

/**
 * main.js — Typeless main process.
 *
 * Phase 2 — dictation path wired end-to-end:
 *   Alt+Space press → capture _targetHwnd → show HUD →
 *   record() → transcribe() → classify() →
 *   [if dictate] setForeground + sleep(50) + keyboard.type(text) →
 *   'typed' HUD state with undo button
 *
 * All other intents (plan, code, command, secret) reserved for later phases.
 */

const {
  app,
  BrowserWindow,
  globalShortcut,
  dialog,
  ipcMain,
  nativeImage,
  session,
} = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execSync, spawn } = require('child_process');

// Load .env first
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { getConfig, reloadConfig, getUserConfigPath } = require('./config/loader');
const { EVENTS }      = require('./telemetry/events');
const analytics       = require('./telemetry/analytics');

// Lazily-required voice / window modules (avoid native-module load errors at startup)
let _recorder    = null;
let _transcriber = null;
let _classifier  = null;
let _platform    = null;
let _interaction = null;

function recorder()    { return _recorder    || (_recorder    = require('./voice/recorder')); }
function transcriber() { return _transcriber || (_transcriber = require('./voice/transcriber')); }
function classifier()  { return _classifier  || (_classifier  = require('./agent/classifier')); }
function platform()    { return _platform    || (_platform    = require('./window/platform')); }
function interaction() { return _interaction || (_interaction = require('./window/interaction')); }

// ── State ─────────────────────────────────────────────────────────────────────

let _currentState = 'idle';
let _targetHwnd   = null;
let _hudWindow    = null;
let _tray         = null;
let _undoAltZ     = false;    // whether Alt+Z is currently registered

const HUD_HEIGHTS = {
  idle: 48, recording: 88, transcribing: 72, planning: 96,
  planReady: 220, editing: 320, executing: 240, stepError: 200,
  clarifying: 260, typed: 88, done: 96, rateLimited: 88, error: 120,
};

// ── State machine ─────────────────────────────────────────────────────────────

function stateChange(newState, data) {
  _currentState = newState;

  if (_hudWindow && !_hudWindow.isDestroyed()) {
    _hudWindow.webContents.send('typeless:stateChange', newState);

    const h = HUD_HEIGHTS[newState] || 48;
    _hudWindow.setSize(380, h);

    if (newState === 'idle') {
      // Keep visible but small; hide after 6s of idle
      setTimeout(() => {
        if (_currentState === 'idle' && _hudWindow && !_hudWindow.isDestroyed()) {
          _hudWindow.hide();
        }
      }, 6000);
    }
  }

  // Tray icon sync
  const trayMod = _tray ? require('./ui/tray') : null;
  if (trayMod) {
    if (newState === 'recording' || newState === 'transcribing') {
      trayMod.setState('recording');
    } else if (newState === 'idle') {
      trayMod.setState('idle');
    } else if (newState === 'error') {
      trayMod.setState('error');
    } else {
      trayMod.setState('processing');
    }
  }
}

// ── Abort routing ─────────────────────────────────────────────────────────────

function handleAbort() {
  switch (_currentState) {
    case 'recording':
      try { recorder().cancel(); } catch { /* best-effort */ }
      break;
    case 'transcribing':
      try { transcriber().abort(); } catch { /* best-effort */ }
      break;
    case 'planReady':
    case 'clarifying':
    case 'executing':
    case 'stepError':
    case 'rateLimited':
    case 'planning':
    case 'editing':
      break; // Phase 3+
    default:
      break;
  }
  stateChange('idle');
}

// ── HUD positioning ───────────────────────────────────────────────────────────

function getHudPosition(width, height) {
  const { screen } = require('electron');
  const { workArea } = screen.getPrimaryDisplay();
  const cfg = getConfig();
  const pos = (cfg.ui && cfg.ui.hudPosition) || 'bottom-center';

  let x, y;
  if (pos === 'bottom-right') {
    x = Math.round(workArea.x + workArea.width  - width  - 24);
    y = Math.round(workArea.y + workArea.height - height - 24);
  } else if (pos === 'top-center') {
    x = Math.round(workArea.x + (workArea.width  / 2) - (width  / 2));
    y = Math.round(workArea.y + 24);
  } else {
    // bottom-center (default)
    x = Math.round(workArea.x + (workArea.width  / 2) - (width  / 2));
    y = Math.round(workArea.y + workArea.height - height - 24);
  }
  return { x, y };
}

// ── HUD window ────────────────────────────────────────────────────────────────

function createHudWindow() {
  const { x, y } = getHudPosition(380, HUD_HEIGHTS.idle);

  _hudWindow = new BrowserWindow({
    width: 380, height: HUD_HEIGHTS.idle,
    minWidth: 320, maxWidth: 480,
    x, y,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload:             path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation:    true,
      nodeIntegration:     false,
      sandbox:             true,
      webSecurity:         true,
      allowRunningInsecureContent: false,
    },
  });

  _hudWindow.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
  _hudWindow.setAlwaysOnTop(true, 'screen-saver');
  _hudWindow.once('ready-to-show', () => {
    _hudWindow.show();
    stateChange('idle');
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  const trayMod = require('./ui/tray');
  _tray = trayMod.createTray({
    onOpenSettings: openSettings,
    onQuit:         () => app.quit(),
  });
}

function openSettings() {
  const settingsHtml = path.join(__dirname, 'ui', 'settings.html');
  if (!fs.existsSync(settingsHtml)) return;

  const win = new BrowserWindow({
    width: 680, height: 520, resizable: false,
    title: 'Typeless Settings',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.loadFile(settingsHtml);
  win.once('ready-to-show', () => win.show());
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  try {
    execSync('sox --version', { stdio: 'ignore' });
  } catch {
    dialog.showErrorBox(
      'SoX not found',
      'Typeless requires SoX for audio recording.\n' +
      'Install from: https://sourceforge.net/projects/sox/\n' +
      'Then restart Typeless.'
    );
    app.quit();
  }
}

// ── Alt+Z (timed undo hotkey) ─────────────────────────────────────────────────

function armUndoHotkey() {
  if (_undoAltZ) return;
  const cfg = getConfig();
  const undoKey = (cfg.hotkey && cfg.hotkey.undo) || 'Alt+Z';
  const ok = globalShortcut.register(undoKey, () => {
    // Wired to undo/manager.js in Phase 2 (T011)
    if (_hudWindow) _hudWindow.webContents.send('typeless:requestUndo');
  });
  if (ok) _undoAltZ = true;
}

function disarmUndoHotkey() {
  if (!_undoAltZ) return;
  const cfg = getConfig();
  const undoKey = (cfg.hotkey && cfg.hotkey.undo) || 'Alt+Z';
  globalShortcut.unregister(undoKey);
  _undoAltZ = false;
}

// ── Push-to-talk: wait for key release (Windows) ─────────────────────────────

/**
 * Spawn a PowerShell process that polls GetAsyncKeyState every 30ms and
 * exits as soon as Ctrl OR Space is released. Resolves when released.
 * On non-Windows, resolves immediately (silence detection handles stop).
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function waitForKeyRelease(signal) {
  if (os.platform() !== 'win32') return Promise.resolve();

  return new Promise((resolve) => {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KeyState {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
"@
while ($true) {
    Start-Sleep -Milliseconds 30
    $ctrl  = [KeyState]::GetAsyncKeyState(0x11) -band 0x8000
    $space = [KeyState]::GetAsyncKeyState(0x20) -band 0x8000
    if ($ctrl -eq 0 -or $space -eq 0) { break }
}
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
    });
    proc.on('close', resolve);
    proc.on('error', resolve); // best-effort — fall back to silence detection
    if (signal) signal.addEventListener('abort', () => { try { proc.kill(); } catch {} });
  });
}

// ── Dictation pipeline ────────────────────────────────────────────────────────

// Monotonically-increasing run ID — incremented on every new dictation start.
// Each async step checks _dictationRunId === myId before continuing, so a newer
// key press instantly supersedes an in-flight transcription/paste.
let _dictationRunId = 0;

async function runDictationPath() {
  const myId = ++_dictationRunId;

  // 1. Show HUD immediately — zero delay
  if (_hudWindow && !_hudWindow.isDestroyed()) _hudWindow.show();
  stateChange('recording');
  analytics.emit(EVENTS.RECORDING_STARTED, {});

  // 2. Start SoX recording IMMEDIATELY — before any synchronous OS calls.
  //    getForegroundWindow() uses spawnSync (PowerShell, ~300 ms); running it
  //    before recorder.start() was the source of the startup lag.
  const recorderMod = recorder();
  const recPromise  = recorderMod.start('dictate');
  waitForKeyRelease().then(() => recorderMod.stop());

  // 3. Capture target window WHILE SoX is already capturing audio.
  //    spawnSync blocks the event loop here, but SoX runs in a separate process
  //    so audio capture continues uninterrupted.
  const windowInfo = platform().getForegroundWindow();
  _targetHwnd = windowInfo ? windowInfo.hwnd : null;

  // 4. Wait for recording to finish (key release or silence auto-stop).
  let wavBuffer = null;
  try {
    wavBuffer = await recPromise;
  } catch (err) {
    const code = (err && err.code) || 'NO_AUDIO_DEVICE';
    stateChange('error');
    if (_hudWindow) {
      _hudWindow.webContents.send('typeless:error', {
        code,
        message: err.message || code,
        retryable: false,
      });
    }
    analytics.emit(EVENTS.RECORDING_STOPPED, { status: 'error' });
    return;
  }

  analytics.emit(EVENTS.RECORDING_STOPPED, { status: 'ok' });

  // If a newer dictation was started while we were recording, silently discard this result
  if (_dictationRunId !== myId) return;

  if (!wavBuffer) {
    // User cancelled or empty recording
    stateChange('idle');
    return;
  }

  // 5. Transcribe
  stateChange('transcribing');

  let transcript = '';
  try {
    transcript = await transcriber().transcribe(wavBuffer);
  } catch (err) {
    if (_dictationRunId !== myId) return; // superseded — don't show error from old run
    const code = (err && err.code) || 'TRANSCRIPTION_API_ERROR';

    if (code === 'RATE_LIMITED') {
      stateChange('rateLimited');
      if (_hudWindow) {
        _hudWindow.webContents.send('typeless:error', {
          code: 'RATE_LIMITED',
          message: 'Rate limited — please wait a moment',
          retryable: true,
        });
      }
    } else {
      stateChange('error');
      if (_hudWindow) {
        _hudWindow.webContents.send('typeless:error', {
          code,
          message: err.message || code,
          retryable: code !== 'EMPTY_TRANSCRIPT',
        });
      }
    }
    analytics.emit(EVENTS.TRANSCRIPTION_COMPLETED, { status: 'error', code });
    return;
  }

  if (_dictationRunId !== myId) return; // superseded during transcription API call

  analytics.emit(EVENTS.TRANSCRIPTION_COMPLETED, { status: 'ok' });

  // 6. Classify intent
  const { intent, credentialName } = classifier().classify(transcript);
  analytics.emit(EVENTS.INTENT_CLASSIFIED, { intent });

  // 7. Route by intent
  switch (intent) {
    case 'dictate':
    case 'command':   // MVP falls back to dictate
    case 'code':      // MVP falls back to dictate (Phase 4 for real code mode)
      await handleDictate(transcript);
      break;

    case 'undo':
      // Wired to undo/manager.js in Phase 2 (T011)
      stateChange('idle');
      break;

    case 'secret':
      // Wired to vault.js in Phase 2 (T010)
      stateChange('error');
      if (_hudWindow) {
        _hudWindow.webContents.send('typeless:error', {
          code: 'VAULT_MISS',
          message: `Vault not yet implemented. Credential: "${credentialName}"`,
          retryable: false,
        });
      }
      break;
  }
}

async function handleDictate(text) {
  if (!text || !text.trim()) {
    stateChange('idle');
    return;
  }

  if (!_targetHwnd) {
    stateChange('error');
    if (_hudWindow) {
      _hudWindow.webContents.send('typeless:error', {
        code: 'WINDOW_NOT_FOUND',
        message: 'No target window — could not capture foreground window',
        retryable: false,
      });
    }
    return;
  }

  try {
    await interaction().typeAtWindow(_targetHwnd, text);

    // 7. Show 'typed' state with undo button
    stateChange('typed');
    if (_hudWindow) {
      _hudWindow.webContents.send('typeless:stateChange', 'typed');
    }

    // Arm Alt+Z undo for 10 s
    armUndoHotkey();
    setTimeout(() => {
      disarmUndoHotkey();
      if (_currentState === 'typed') stateChange('idle');
    }, 10_000);

    if (_hudWindow) {
      _hudWindow.webContents.send('typeless:undoAvailable', { available: true });
    }
  } catch (err) {
    const code = (err && err.code) || 'TYPE_FAILED';
    stateChange('error');
    if (_hudWindow) {
      _hudWindow.webContents.send('typeless:error', {
        code,
        message: err.message || code,
        retryable: false,
      });
    }
  }
}

// ── Hotkey registration ───────────────────────────────────────────────────────

function warnHotkeyConflict(hotkey) {
  console.warn(`[hotkeys] ${hotkey} is taken by another app`);
  if (_tray) {
    const trayMod = require('./ui/tray');
    trayMod.setState('error', `${hotkey} is taken by another app. Remap in Settings → Hotkeys.`);
  }
}

function registerHotkeys() {
  const cfg = getConfig();
  const dictateKey = (cfg.hotkey && cfg.hotkey.dictate) || 'Ctrl+Space';
  const planKey    = (cfg.hotkey && cfg.hotkey.plan)    || 'Ctrl+Shift+Space';
  const abortKey   = (cfg.hotkey && cfg.hotkey.abort)   || 'Alt+Shift+Escape';

  // Dictate
  const dictateOk = globalShortcut.register(dictateKey, () => {
    // Already recording — ignore repeated key-down events (key held)
    if (_currentState === 'recording') return;

    // If a previous dictation is mid-flight (transcribing, pasting, error, etc.),
    // abort it and start fresh immediately — never queue or wait.
    if (_currentState !== 'idle') {
      _dictationRunId++;               // invalidate the in-flight run
      transcriber().abort();           // cancel in-flight API call if any
      recorder().cancel();             // stop any lingering recorder
      _currentState = 'idle';          // force state so runDictationPath can proceed
    }

    runDictationPath().catch((err) => {
      console.error('[dictate] Unhandled error:', err);
      stateChange('idle');
    });
  });
  if (!dictateOk) warnHotkeyConflict(dictateKey);

  // Plan (Phase 3 — recording start only for now)
  const planOk = globalShortcut.register(planKey, () => {
    if (_currentState !== 'idle') return;
    // Full plan path wired in Phase 3
    if (_hudWindow) _hudWindow.show();
    stateChange('recording');
  });
  if (!planOk) warnHotkeyConflict(planKey);

  // Abort — permanently registered
  const abortOk = globalShortcut.register(abortKey, handleAbort);
  if (!abortOk) warnHotkeyConflict(abortKey);

  // Undo is NOT registered here — timed, managed by arm/disarm above
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.on('typeless:requestAbort',   handleAbort);
ipcMain.on('typeless:cancelPlan',     handleAbort);
ipcMain.on('typeless:abortExecution', handleAbort);
ipcMain.on('typeless:retryStep',      () => {});
ipcMain.on('typeless:skipStep',       () => {});
ipcMain.on('typeless:confirmPlan',    () => {});
ipcMain.on('typeless:requestUndo',    () => {});
ipcMain.on('typeless:submitClarification', () => {});

ipcMain.handle('typeless:getConfig', () => getConfig());

ipcMain.handle('typeless:saveConfig', async (_event, delta) => {
  const configPath = getUserConfigPath();
  try {
    let current = {};
    if (fs.existsSync(configPath)) {
      current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    const updated = Object.assign({}, current, delta);
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf8');
    reloadConfig();

    // If hudPosition changed, reposition the HUD
    if (delta.ui && delta.ui.hudPosition && _hudWindow && !_hudWindow.isDestroyed()) {
      const { width, height } = _hudWindow.getBounds();
      const { x, y } = getHudPosition(width, height);
      _hudWindow.setPosition(x, y);
    }
    analytics.emit(EVENTS.SETTINGS_CHANGED, { keys: Object.keys(delta) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('typeless:getVaultNames',    () => []);
ipcMain.handle('typeless:storeCredential',  () => ({ ok: true }));
ipcMain.handle('typeless:deleteCredential', () => ({ ok: true }));
ipcMain.handle('typeless:testApiKey',       () => ({ ok: false, error: 'not_implemented' }));
ipcMain.handle('typeless:editPlan',         () => ({ ok: false, error: { code: 'not_implemented' } }));

ipcMain.handle('typeless:browseFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

// ── Content Security Policy ───────────────────────────────────────────────────

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'",
        ],
      },
    });
  });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  analytics.emit(EVENTS.APP_STARTED, {});

  await checkPrerequisites();
  createTray();
  createHudWindow();
  registerHotkeys();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  analytics.emit(EVENTS.APP_QUIT, {});
});

// Prevent quit when all windows close — app lives in tray
app.on('window-all-closed', (e) => e.preventDefault());

// Surface unhandled rejections
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
  analytics.emit(EVENTS.ERROR_UNHANDLED, {});
  if (_hudWindow && !_hudWindow.isDestroyed()) {
    _hudWindow.webContents.send('typeless:error', {
      code:      'UNHANDLED_REJECTION',
      message:   'An unexpected error occurred',
      retryable: false,
    });
  }
});
