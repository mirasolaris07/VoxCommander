'use strict';

/**
 * window/platform/win32/manager.js — Win32 window manager.
 *
 * Phase 2, Step 23.
 *
 * Uses PowerShell P/Invoke to call Win32 APIs (GetForegroundWindow,
 * EnumWindows) without requiring a native addon.
 *
 * windowList TTL: 1 s — refreshed before every LLM call inside planner.
 * _targetHwnd: always captured fresh on hotkey press, never from this cache.
 */

const { spawnSync } = require('child_process');

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 1000;
let _windowListCache = null;
let _windowListTs    = 0;

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

// ── Win32 type definitions ────────────────────────────────────────────────────

const ADD_TYPE_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
`;

// ── getForegroundWindow() ─────────────────────────────────────────────────────

/**
 * Return info about the currently-focused window.
 * Captured FRESH on every call — no caching.
 * @returns {{ hwnd: string, title: string, processName: string } | null}
 */
function getForegroundWindow() {
  try {
    const script = `
${ADD_TYPE_SCRIPT}
$hwnd = [Win32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[Win32]::GetWindowText($hwnd, $sb, 256) | Out-Null
$procId = [uint32]0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
$procName = if ($proc) { $proc.Name } else { '' }
Write-Output "$hwnd|$($sb.ToString())|$procName"
`;

    const out   = ps(script);
    const parts = out.split('|');
    if (parts.length < 3) return null;

    return {
      hwnd:        parts[0].trim(),
      title:       parts[1].trim(),
      processName: parts[2].trim(),
    };
  } catch {
    return null;
  }
}

// ── getWindowList() ───────────────────────────────────────────────────────────

/**
 * Return a list of visible windows (title + hwnd + processName).
 * Results are cached for CACHE_TTL_MS to avoid hammering the OS.
 * @param {{ force?: boolean }} [opts]
 * @returns {{ hwnd: string, title: string, processName: string }[]}
 */
function getWindowList({ force = false } = {}) {
  const now = Date.now();
  if (!force && _windowListCache && (now - _windowListTs) < CACHE_TTL_MS) {
    return _windowListCache;
  }

  try {
    const script = `
${ADD_TYPE_SCRIPT}
$windows = New-Object System.Collections.Generic.List[string]
$callback = [Win32+EnumWindowsProc]{
    param($hwnd, $lParam)
    if ([Win32]::IsWindowVisible($hwnd)) {
        $sb = New-Object System.Text.StringBuilder 256
        [Win32]::GetWindowText($hwnd, $sb, 256) | Out-Null
        $title = $sb.ToString()
        if ($title.Length -gt 0) {
            $procId = [uint32]0
            [Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            $name = if ($proc) { $proc.Name } else { '' }
            $windows.Add("$hwnd|$title|$name")
        }
    }
    return $true
}
[Win32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
$windows | ForEach-Object { Write-Output $_ }
`;

    const out     = ps(script);
    const windows = out.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|');
        return {
          hwnd:        (parts[0] || '').trim(),
          title:       (parts[1] || '').trim(),
          processName: (parts[2] || '').trim(),
        };
      })
      .filter((w) => w.hwnd && w.title);

    _windowListCache = windows;
    _windowListTs    = now;
    return windows;
  } catch {
    return _windowListCache || [];
  }
}

module.exports = { getForegroundWindow, getWindowList };
