'use strict';

/**
 * config/store.js — electron-store wrapper for Typeless runtime state (Layer 3).
 *
 * Shape:
 *   history[]            — last 20 dictate/plan/code/command/secret entries (oldest dropped at 21)
 *   windowProfiles{}     — { appName → { x, y } } learned input coordinates
 *   scheduledTasks[]     — persisted cron task definitions (CRUD via scheduler/taskStore.js)
 *   onboarding.completed — boolean; true after user finishes the 5-step onboarding wizard
 *
 * NOT here:
 *   undoStack — in-memory only (undo/manager.js). Never persisted.
 *   API keys  — stored in OS keychain via keytar (security/vault.js). Never in store.
 */

const HISTORY_MAX = 20;

// Schema defaults — electron-store applies these on first run and fills missing keys.
const STORE_DEFAULTS = {
  history: [],
  windowProfiles: {},
  scheduledTasks: [],
  onboarding: {
    completed: false,
  },
};

// ── Singleton ─────────────────────────────────────────────────────────────────
/** @type {import('electron-store') | null} */
let _store = null;

/**
 * Return (or lazily create) the electron-store singleton.
 *
 * Handles two contexts:
 *   1. Normal Electron main process — uses app.getPath('userData') automatically.
 *   2. Unit-test / CLI context      — electron-store falls back to os.tmpdir() or
 *      CWD when Electron is absent; tests may also inject a custom store via
 *      _setStoreForTest().
 *
 * @returns {import('electron-store')}
 */
function getStore() {
  if (_store) return _store;

  // electron-store v8 supports both ESM and CJS via a dual-exports map.
  // We load it dynamically so that unit tests can stub it before first call.
  const Store = requireStore();

  _store = new Store({
    name: 'runtime.store',
    defaults: STORE_DEFAULTS,
    // Intentionally unencrypted — see CLAUDE.md "electron-store encryption decision".
    // OS filesystem permissions are the only access control applied.
    encryptionKey: undefined,
    clearInvalidConfig: false, // never silently wipe — surface corruption to caller
  });

  return _store;
}

/**
 * Load the Store constructor, gracefully handling both CJS and dynamic-import
 * environments.  In practice this is always synchronous (CJS interop).
 */
function requireStore() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('electron-store');
}

// ── History helpers ───────────────────────────────────────────────────────────

/**
 * Append one entry to history[], dropping the oldest when the cap is exceeded.
 *
 * Entry shape (all callers must provide):
 * {
 *   id:         string,            // nanoid — callers are responsible for uniqueness
 *   timestamp:  number,            // Date.now()
 *   mode:       'dictate'|'plan'|'code'|'command'|'secret',
 *   transcript: string | null,     // null for 'secret' — never persist credential names
 *   steps:      object[] | null,   // plan/code steps; null for dictate/command/secret
 *   status:     'ok' | 'error',
 *   error:      string | null,     // error code if status='error'
 * }
 *
 * @param {object} entry
 */
function pushHistory(entry) {
  const store = getStore();
  const history = store.get('history', []);
  history.push(entry);
  // Drop oldest entries beyond the cap (rolling window — never fully cleared mid-session)
  if (history.length > HISTORY_MAX) {
    history.splice(0, history.length - HISTORY_MAX);
  }
  store.set('history', history);
}

/**
 * Return all history entries (newest last).
 * @returns {object[]}
 */
function getHistory() {
  return getStore().get('history', []);
}

/**
 * Remove all history entries.  Called only when the user explicitly clears history.
 */
function clearHistory() {
  getStore().set('history', []);
}

// ── Window profiles helpers ───────────────────────────────────────────────────

/**
 * Return the persisted input coordinates for a known app, or undefined.
 * @param {string} appName
 * @returns {{ x: number, y: number } | undefined}
 */
function getWindowProfile(appName) {
  const profiles = getStore().get('windowProfiles', {});
  return profiles[appName];
}

/**
 * Persist (or overwrite) the input coordinates for an app.
 * @param {string} appName
 * @param {{ x: number, y: number }} coords
 */
function setWindowProfile(appName, coords) {
  const store = getStore();
  const profiles = store.get('windowProfiles', {});
  profiles[appName] = coords;
  store.set('windowProfiles', profiles);
}

/**
 * Remove a stored window profile (e.g. if the app is uninstalled).
 * @param {string} appName
 */
function deleteWindowProfile(appName) {
  const store = getStore();
  const profiles = store.get('windowProfiles', {});
  delete profiles[appName];
  store.set('windowProfiles', profiles);
}

// ── Scheduled tasks helpers ───────────────────────────────────────────────────
// Higher-level CRUD lives in scheduler/taskStore.js — these are the raw primitives.

/**
 * Return all persisted scheduled task definitions.
 * @returns {object[]}
 */
function getScheduledTasks() {
  return getStore().get('scheduledTasks', []);
}

/**
 * Overwrite the entire scheduled tasks list.
 * @param {object[]} tasks
 */
function setScheduledTasks(tasks) {
  getStore().set('scheduledTasks', tasks);
}

// ── Onboarding helpers ────────────────────────────────────────────────────────

/**
 * Return whether the user has completed the onboarding wizard.
 * @returns {boolean}
 */
function isOnboardingCompleted() {
  return getStore().get('onboarding.completed', false);
}

/**
 * Mark onboarding as completed.  Called by ui/onboarding.js on "Finish setup ✓".
 */
function completeOnboarding() {
  getStore().set('onboarding.completed', true);
}

// ── Test helper ───────────────────────────────────────────────────────────────

/**
 * Replace the singleton with a test double.
 * Call with `null` to restore the real store on the next getStore() call.
 *
 * @param {object | null} testStore
 */
function _setStoreForTest(testStore) {
  _store = testStore;
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  getStore,
  HISTORY_MAX,
  // History
  pushHistory,
  getHistory,
  clearHistory,
  // Window profiles
  getWindowProfile,
  setWindowProfile,
  deleteWindowProfile,
  // Scheduled tasks
  getScheduledTasks,
  setScheduledTasks,
  // Onboarding
  isOnboardingCompleted,
  completeOnboarding,
  // Testing
  _setStoreForTest,
};
