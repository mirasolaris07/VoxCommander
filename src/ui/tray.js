'use strict';

/**
 * ui/tray.js — System tray icon with 4 states.
 *
 * Phase 2, Step 26.
 *
 * States:
 *   idle        — default, both hotkeys shown in tooltip
 *   recording   — red variant
 *   processing  — spinner / processing variant
 *   error       — amber variant
 *
 * Assets expected in src/assets/:
 *   tray-idle.png, tray-recording.png, tray-processing.png, tray-error.png
 *   (16×16 and 32×32 — Windows requires both in the PNG or ICO)
 *
 * Falls back to a blank native image if assets are missing.
 */

const path        = require('path');
const fs          = require('fs');
const { Tray, Menu, nativeImage, app } = require('electron');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// ── Icon loader ───────────────────────────────────────────────────────────────

function loadIcon(name) {
  const iconPath = path.join(ASSETS_DIR, `${name}.png`);
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  // Fallback: 1×1 transparent PNG so Tray doesn't crash
  return nativeImage.createEmpty();
}

const TRAY_ICONS = {
  idle:       loadIcon('tray-idle'),
  recording:  loadIcon('tray-recording'),
  processing: loadIcon('tray-processing'),
  error:      loadIcon('tray-error'),
};

// ── Tray instance ─────────────────────────────────────────────────────────────

let _tray     = null;
let _state    = 'idle';
let _onOpen   = null;
let _onQuit   = null;

// ── createTray() ──────────────────────────────────────────────────────────────

/**
 * Create the system tray icon.
 * @param {{ onOpenSettings?: () => void, onQuit?: () => void }} opts
 */
function createTray({ onOpenSettings, onQuit } = {}) {
  _onOpen = onOpenSettings || null;
  _onQuit = onQuit || (() => app.quit());

  _tray = new Tray(TRAY_ICONS.idle);
  _tray.setToolTip('Typeless — Alt+Space to dictate · Alt+Shift+Space to plan');
  _rebuildMenu();

  return _tray;
}

// ── setState() ────────────────────────────────────────────────────────────────

/**
 * Update the tray icon to reflect the current app state.
 * @param {'idle'|'recording'|'processing'|'error'} state
 * @param {string} [tooltip]
 */
function setState(state, tooltip) {
  if (!_tray) return;
  _state = state;

  const icon = TRAY_ICONS[state] ?? TRAY_ICONS.idle;
  _tray.setImage(icon);

  const tip = tooltip || _defaultTooltip(state);
  _tray.setToolTip(tip);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _defaultTooltip(state) {
  switch (state) {
    case 'recording':  return 'Typeless — Recording…';
    case 'processing': return 'Typeless — Processing…';
    case 'error':      return 'Typeless — Error (see tray menu)';
    default:           return 'Typeless — Alt+Space to dictate · Alt+Shift+Space to plan';
  }
}

function _rebuildMenu() {
  if (!_tray) return;
  const template = [
    ...(
      _onOpen
        ? [{ label: 'Settings', click: _onOpen }, { type: 'separator' }]
        : []
    ),
    { label: 'Quit', click: _onQuit },
  ];
  _tray.setContextMenu(Menu.buildFromTemplate(template));
}

module.exports = { createTray, setState };
