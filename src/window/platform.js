'use strict';

/**
 * window/platform.js — Cross-platform window manager adapter.
 *
 * Phase 2, Step 23.
 *
 * Loads the correct platform implementation based on process.platform.
 * Only win32 is implemented in Phase 0–2; darwin and linux are stubs.
 *
 * Exports:
 *   getForegroundWindow() → { hwnd, title, processName } | null
 *   getWindowList()       → { hwnd, title, processName }[]
 *   setForeground(hwnd)   → void  (throws WINDOW_NOT_FOUND if stale)
 *   isWindowValid(hwnd)   → boolean
 */

const path = require('path');

let _impl = null;

function _load() {
  if (_impl) return _impl;

  const platform = process.platform;

  if (platform === 'win32') {
    const mgr   = require('./platform/win32/manager');
    const focus = require('./platform/win32/focus');
    _impl = {
      getForegroundWindow: mgr.getForegroundWindow,
      getWindowList:       mgr.getWindowList,
      setForeground:       focus.setForeground,
      isWindowValid:       focus.isWindowValid,
    };
  } else {
    // darwin / linux — stub for Phase 6 cross-platform addon
    _impl = {
      getForegroundWindow: () => null,
      getWindowList:       () => [],
      setForeground:       () => {},
      isWindowValid:       () => false,
    };
  }

  return _impl;
}

module.exports = {
  getForegroundWindow: (...a) => _load().getForegroundWindow(...a),
  getWindowList:       (...a) => _load().getWindowList(...a),
  setForeground:       (...a) => _load().setForeground(...a),
  isWindowValid:       (...a) => _load().isWindowValid(...a),
};
