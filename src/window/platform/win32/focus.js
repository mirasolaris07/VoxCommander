'use strict';

/**
 * window/platform/win32/focus.js — Win32 SetForegroundWindow + thread-attach.
 *
 * Phase 2, Step 23.
 *
 * SetForegroundWindow requires thread-input attachment when the calling
 * process does not own the foreground thread.
 *
 * Returns true on success, throws WINDOW_NOT_FOUND if the handle is stale.
 */

const { spawnSync } = require('child_process');

// ── Win32 type definition ─────────────────────────────────────────────────────

const ADD_TYPE = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Focus {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint dwProcessId);
    [DllImport("user32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
`;

// ── PowerShell helper ─────────────────────────────────────────────────────────

/**
 * Run a multi-line PowerShell script and return stdout (trimmed).
 * Uses -EncodedCommand (Base64 UTF-16LE) to avoid cmd.exe quoting issues.
 * @param {string} script
 * @returns {string}
 */
function ps(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result  = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], {
    encoding:    'utf8',
    timeout:     5000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `PowerShell exited ${result.status}`);
  return (result.stdout || '').trim();
}

// ── setForeground() ───────────────────────────────────────────────────────────

/**
 * Bring a window to the foreground using thread-input attachment.
 *
 * @param {string|number} hwnd  The window handle (decimal integer as string or number)
 * @returns {void}
 * @throws {{ code: 'WINDOW_NOT_FOUND' }} if the handle is stale / window gone
 */
function setForeground(hwnd) {
  if (!hwnd) {
    const err  = new Error('WINDOW_NOT_FOUND');
    err.code   = 'WINDOW_NOT_FOUND';
    throw err;
  }

  const script = `
${ADD_TYPE}
$hwnd = [IntPtr]${hwnd}
if (-not [Win32Focus]::IsWindow($hwnd)) { Write-Output 'NOT_FOUND'; exit }
if (-not [Win32Focus]::IsWindowVisible($hwnd)) { [Win32Focus]::ShowWindow($hwnd, 9) | Out-Null }
$procId = [uint32]0
[Win32Focus]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$targetTid = [Win32Focus]::GetWindowThreadProcessId($hwnd, [ref]$procId)
$selfTid   = [Win32Focus]::GetCurrentThreadId()
[Win32Focus]::AttachThreadInput($selfTid, $targetTid, $true) | Out-Null
$result = [Win32Focus]::SetForegroundWindow($hwnd)
[Win32Focus]::AttachThreadInput($selfTid, $targetTid, $false) | Out-Null
if ($result) { Write-Output 'OK' } else { Write-Output 'FAILED' }
`;

  try {
    const out = ps(script);
    if (out === 'NOT_FOUND') {
      const err  = new Error('WINDOW_NOT_FOUND');
      err.code   = 'WINDOW_NOT_FOUND';
      throw err;
    }
    // FAILED is non-fatal — some apps (Task Manager, elevated) resist; nut-js will still try
  } catch (err) {
    if (err.code === 'WINDOW_NOT_FOUND') throw err;
    // PowerShell spawn failure — best-effort, log and continue
    console.warn('[win32/focus] setForeground failed:', err.message);
  }
}

// ── isWindowValid() ───────────────────────────────────────────────────────────

/**
 * Check whether a window handle is still valid and visible.
 * @param {string|number} hwnd
 * @returns {boolean}
 */
function isWindowValid(hwnd) {
  if (!hwnd) return false;
  try {
    const script = `
${ADD_TYPE}
$hwnd = [IntPtr]${hwnd}
$valid = [Win32Focus]::IsWindow($hwnd) -and [Win32Focus]::IsWindowVisible($hwnd)
Write-Output $valid
`;
    const out = ps(script).toLowerCase();
    return out === 'true';
  } catch {
    return false;
  }
}

module.exports = { setForeground, isWindowValid };
