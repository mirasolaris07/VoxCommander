'use strict';

/**
 * window/interaction.js — Keyboard and mouse interactions via nut-js.
 *
 * Phase 2, Step 24.
 *
 * ALL keyboard.type() calls MUST be preceded by:
 *   1. platform.setForeground(_targetHwnd)
 *   2. await sleep(50)
 *
 * This is enforced in typeAtWindow() below.
 *
 * nut-js UIPI limitation (Windows):
 *   keyboard.type() is blocked against elevated processes (Task Manager, UAC).
 *   If TYPE_FAILED is thrown, the error message instructs the user to run
 *   Typeless as administrator.
 */

const { keyboard, Key, mouse, Button, Point } = require('@nut-tree-fork/nut-js');
const { clipboard } = require('electron');
const platform = require('./platform');

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function typeError(code, msg, cause) {
  const err  = new Error(msg || code);
  err.code   = code;
  if (cause) err.cause = cause;
  return err;
}

// ── Type text at a specific window ────────────────────────────────────────────

/**
 * Re-focus the target window and type text into it.
 *
 * @param {string|number} hwnd   The window handle captured on hotkey press
 * @param {string}        text   Text to type (verbatim — NOT interpolated here)
 * @returns {Promise<void>}
 * @throws {{ code: 'WINDOW_NOT_FOUND' | 'TYPE_FAILED' }}
 */
async function typeAtWindow(hwnd, text) {
  // Verify the window is still valid before attempting to type
  if (!platform.isWindowValid(hwnd)) {
    throw typeError('WINDOW_NOT_FOUND', 'Target window is no longer valid or visible');
  }

  // SetForegroundWindow + mandatory 50 ms sleep
  platform.setForeground(hwnd);
  await sleep(50);

  // Re-verify after sleep — user may have switched away
  if (!platform.isWindowValid(hwnd)) {
    throw typeError(
      'WINDOW_NOT_FOUND',
      'Target window closed or became invisible during transcription'
    );
  }

  // Use clipboard paste for instant insertion — character-by-character typing
  // is too slow for any non-trivial transcript. Save and restore clipboard.
  const prevClipboard = clipboard.readText();
  try {
    clipboard.writeText(text);
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
    await sleep(80); // let paste complete before restoring clipboard
  } catch (err) {
    const msg = err && err.message ? err.message : '';
    const isUipi = msg.toLowerCase().includes('uipi') ||
                   msg.toLowerCase().includes('access') ||
                   msg.toLowerCase().includes('privilege');

    if (isUipi) {
      throw typeError(
        'TYPE_FAILED',
        'Target application requires administrator. ' +
        'Restart Typeless as administrator to type into it.'
      );
    }
    throw typeError('TYPE_FAILED', `Paste failed: ${msg}`, err);
  } finally {
    clipboard.writeText(prevClipboard);
  }
}

// ── Hotkey sender ─────────────────────────────────────────────────────────────

/**
 * Send a key combination (e.g. ['ctrl', 'c']).
 * @param {string[]} keys
 * @returns {Promise<void>}
 */
async function sendHotkey(keys) {
  const nutKeys = keys.map((k) => {
    const upper = k.toUpperCase();
    return Key[upper] !== undefined ? Key[upper] : k;
  });
  await keyboard.pressKey(...nutKeys);
  await keyboard.releaseKey(...nutKeys);
}

// ── Mouse helpers ─────────────────────────────────────────────────────────────

/**
 * Move mouse to (x, y) and click.
 * @param {number} x
 * @param {number} y
 * @param {'left'|'right'|'middle'} [button='left']
 * @returns {Promise<void>}
 */
async function click(x, y, button = 'left') {
  const btn = button === 'right'  ? Button.RIGHT  :
              button === 'middle' ? Button.MIDDLE  : Button.LEFT;
  await mouse.move([new Point(x, y)]);
  await mouse.click(btn);
}

/**
 * Move mouse to (x, y) without clicking.
 * @param {number} x
 * @param {number} y
 * @returns {Promise<void>}
 */
async function mouseMove(x, y) {
  await mouse.move([new Point(x, y)]);
}

/**
 * Scroll at (x, y).
 * @param {number} x
 * @param {number} y
 * @param {'up'|'down'|'left'|'right'} direction
 * @param {number} amount
 * @returns {Promise<void>}
 */
async function scroll(x, y, direction, amount) {
  await mouse.move([new Point(x, y)]);
  const scrollAmt = Math.abs(amount || 3);

  switch (direction) {
    case 'up':    await mouse.scrollUp(scrollAmt);    break;
    case 'down':  await mouse.scrollDown(scrollAmt);  break;
    case 'left':  await mouse.scrollLeft(scrollAmt);  break;
    case 'right': await mouse.scrollRight(scrollAmt); break;
  }
}

module.exports = { typeAtWindow, sendHotkey, click, mouseMove, scroll };
