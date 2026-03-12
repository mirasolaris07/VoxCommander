'use strict';

/**
 * ui/preload.js — Secure IPC bridge between renderer and main process.
 *
 * Phase 0, Step 11 / Phase 2, Step 25.
 *
 * This is THE ONLY file that may call ipcRenderer.
 * Renderer code accesses ONLY window.typelessAPI — never ipcRenderer directly.
 *
 * 21 methods exposed:
 *   One-way sends (8): requestAbort, confirmPlan, cancelPlan,
 *     submitClarification, retryStep, skipStep, abortExecution, requestUndo
 *   Invoke/reply (9):  editPlan (15s LLM timeout), getConfig, saveConfig,
 *     getVaultNames, storeCredential, deleteCredential, browseFolder, testApiKey
 *   M→R listeners (4): onStateChange, onPlanReady, onStepProgress,
 *     onError, onUndoAvailable
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── Timeout wrappers ──────────────────────────────────────────────────────────

function invokeWithTimeout(channel, ...args) {
  return Promise.race([
    ipcRenderer.invoke(channel, ...args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('IPC_TIMEOUT')), 5000)
    ),
  ]);
}

function invokeLLMWithTimeout(channel, ...args) {
  return Promise.race([
    ipcRenderer.invoke(channel, ...args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('IPC_TIMEOUT')), 15000)
    ),
  ]);
}

// ── API surface ───────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('typelessAPI', {
  // ── One-way sends ────────────────────────────────────────────────────────────
  requestAbort:        ()        => ipcRenderer.send('typeless:requestAbort'),
  confirmPlan:         ()        => ipcRenderer.send('typeless:confirmPlan'),
  cancelPlan:          ()        => ipcRenderer.send('typeless:cancelPlan'),
  submitClarification: (answer)  => ipcRenderer.send('typeless:submitClarification', answer),
  retryStep:           ()        => ipcRenderer.send('typeless:retryStep'),
  skipStep:            ()        => ipcRenderer.send('typeless:skipStep'),
  abortExecution:      ()        => ipcRenderer.send('typeless:abortExecution'),
  requestUndo:         ()        => ipcRenderer.send('typeless:requestUndo'),

  // ── Two-way invokes ───────────────────────────────────────────────────────────
  editPlan:        (steps)      => invokeLLMWithTimeout('typeless:editPlan', steps),
  getConfig:       ()           => invokeWithTimeout('typeless:getConfig'),
  saveConfig:      (delta)      => invokeWithTimeout('typeless:saveConfig', delta),
  getVaultNames:   ()           => invokeWithTimeout('typeless:getVaultNames'),
  storeCredential: (name, val)  => invokeWithTimeout('typeless:storeCredential', name, val),
  deleteCredential:(name)       => invokeWithTimeout('typeless:deleteCredential', name),
  browseFolder:    ()           => invokeWithTimeout('typeless:browseFolder'),
  testApiKey:      (prov, key)  => invokeWithTimeout('typeless:testApiKey', prov, key),

  // ── Main → Renderer listeners ────────────────────────────────────────────────
  // ipcRenderer.on() stacks on repeated calls.
  // In dev hot-reload scenarios, call removeAllListeners before re-registering.
  onStateChange:   (cb) => ipcRenderer.on('typeless:stateChange',   (_, s) => cb(s)),
  onPlanReady:     (cb) => ipcRenderer.on('typeless:planReady',     (_, d) => cb(d)),
  onStepProgress:  (cb) => ipcRenderer.on('typeless:stepProgress',  (_, d) => cb(d)),
  onError:         (cb) => ipcRenderer.on('typeless:error',         (_, d) => cb(d)),
  onUndoAvailable: (cb) => ipcRenderer.on('typeless:undoAvailable', (_, d) => cb(d)),
});
