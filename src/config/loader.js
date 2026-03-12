'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const dotenv = require('dotenv');

// Layer 1: Load .env secrets — must happen before any other module reads process.env
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const CONFIG_FILENAME = 'app.config.json';

/**
 * Resolve the user-writable config path.
 *   Production : %APPDATA%\Typeless\app.config.json
 *   Test / CLI : falls back via process.env.APPDATA → os.homedir()
 * @returns {string}
 */
function getUserConfigPath() {
  try {
    // Works only after app.ready; throws in test context
    const { app } = require('electron');
    return path.join(app.getPath('appData'), 'Typeless', CONFIG_FILENAME);
  } catch {
    // Non-Electron context (unit tests, scripts)
    const appData = process.env.APPDATA || os.homedir();
    return path.join(appData, 'Typeless', CONFIG_FILENAME);
  }
}

/**
 * Recursively deep-freeze an object so callers cannot mutate config at runtime.
 * @param {object} obj
 * @returns {Readonly<object>}
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.getOwnPropertyNames(obj).forEach((name) => {
    const val = obj[name];
    if (val && typeof val === 'object') deepFreeze(val);
  });
  return Object.freeze(obj);
}

/**
 * Non-mutating deep-merge: source values override target values recursively.
 * Arrays are replaced wholesale (not concatenated).
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function deepMerge(target, source) {
  const out = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)) {
      out[key] = deepMerge(typeof tv === 'object' && tv !== null ? tv : {}, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

/**
 * Generate an ISO-based backup suffix safe for Windows filenames.
 * @returns {string}
 */
function backupSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Attempt to create a timestamped backup of a file.
 * Failures are silently swallowed — the backup is best-effort.
 * @param {string} filePath
 * @returns {string} Path the backup was written to
 */
function tryBackup(filePath) {
  const backupPath = filePath.replace('.json', `.backup-${backupSuffix()}.json`);
  try {
    fs.copyFileSync(filePath, backupPath);
  } catch {
    // Best-effort; never block startup
  }
  return backupPath;
}

/**
 * Load, validate (AJV), and deep-freeze the application configuration.
 *
 * 3-layer merge order (last wins):
 *   Layer 1 — Defaults from config/defaults.js          (base values)
 *   Layer 2 — User overrides in app.config.json         (%APPDATA%/Typeless)
 *   Layer 3 — .env secrets already injected into        process.env by dotenv
 *
 * On AJV validation failure:
 *   → saves a timestamped backup of the bad file
 *   → resets user config to defaults on disk
 *   → continues with defaults (logs CONFIG_INVALID)
 *
 * @returns {Readonly<object>} Frozen config object
 */
function loadConfig() {
  // ── Defaults (Layer 1) ─────────────────────────────────────────────────────
  let defaults = {};
  try {
    ({ DEFAULTS: defaults } = require('./defaults'));
  } catch {
    // defaults.js created in T003; gracefully absent during bootstrap
  }

  // ── AJV schema ─────────────────────────────────────────────────────────────
  let validate = null;
  try {
    const Ajv = require('ajv');
    const schema = require('./app.config.schema.json');
    const ajv = new Ajv({ allErrors: true, useDefaults: true });
    validate = ajv.compile(schema);
  } catch {
    // Schema / AJV absent during early bootstrap — skip validation
  }

  // ── User config file (Layer 2) ─────────────────────────────────────────────
  const userConfigPath = getUserConfigPath();
  let userRaw = {};

  if (fs.existsSync(userConfigPath)) {
    try {
      userRaw = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
    } catch {
      // Corrupt JSON → backup + reset to empty (defaults will fill in)
      const backup = tryBackup(userConfigPath);
      console.error(
        `[config/loader] Corrupt ${CONFIG_FILENAME} — reset to defaults. Backup: ${backup}`
      );
      userRaw = {};
      try {
        fs.writeFileSync(userConfigPath, JSON.stringify(defaults, null, 2), 'utf8');
      } catch { /* best-effort */ }
    }
  } else {
    // First run: seed user config directory with default values
    try {
      fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
      fs.writeFileSync(userConfigPath, JSON.stringify(defaults, null, 2), 'utf8');
    } catch { /* best-effort */ }
  }

  // ── Merge defaults + user overrides ────────────────────────────────────────
  let merged = deepMerge(defaults, userRaw);

  // ── AJV validation ─────────────────────────────────────────────────────────
  if (validate) {
    const valid = validate(merged);
    if (!valid) {
      // CONFIG_INVALID: backup bad file, reset to defaults
      if (fs.existsSync(userConfigPath)) {
        const backup = tryBackup(userConfigPath);
        console.error(
          `[config/loader] CONFIG_INVALID — AJV errors:`,
          validate.errors,
          `— Backup: ${backup}`
        );
      }
      merged = Object.assign({}, defaults);
      try {
        fs.writeFileSync(userConfigPath, JSON.stringify(defaults, null, 2), 'utf8');
      } catch { /* best-effort */ }
    }
  }

  return deepFreeze(merged);
}

// ── Singleton ─────────────────────────────────────────────────────────────────
/** @type {Readonly<object> | null} */
let _config = null;

/**
 * Return the frozen config singleton.
 * Loads once on first call; subsequent calls return the cached object.
 * @returns {Readonly<object>}
 */
function getConfig() {
  if (!_config) _config = loadConfig();
  return _config;
}

/**
 * Invalidate the singleton and reload config from disk.
 * Called by the `saveConfig` IPC handler after writing user changes.
 * @returns {Readonly<object>}
 */
function reloadConfig() {
  _config = null;
  return getConfig();
}

module.exports = { getConfig, reloadConfig, getUserConfigPath };
