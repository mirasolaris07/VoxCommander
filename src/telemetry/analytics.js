'use strict';

/**
 * telemetry/analytics.js — Fire-and-forget analytics emitter.
 *
 * Phase 0, Step 7.
 *
 * Behaviour:
 *   - Emits one JSONL line per event to a local log file.
 *   - Calls redact() on every metadata payload before writing.
 *   - All writes are fire-and-forget: never throws, never awaited by callers.
 *   - Optionally forwards batches to a cloud endpoint via telemetry/batcher.js
 *     when telemetry.enabled is true.
 *   - Respects analytics.localLogEnabled and analytics.retentionDays from config.
 *
 * Usage:
 *   const analytics = require('./telemetry/analytics');
 *   const { EVENTS } = require('./telemetry/events');
 *   analytics.emit(EVENTS.PLAN_CREATED, { stepCount: 5, provider: 'gemini', durationMs: 420 });
 *
 * What NEVER appears in any event payload:
 *   audio · transcribed text · typed text · step params · screenshots ·
 *   API keys · credential names · credential values · full error messages · stack traces
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { redact } = require('./redact');

// ── Log file path ─────────────────────────────────────────────────────────────

/**
 * Resolve the analytics JSONL path.
 * Uses the Electron userData dir in production; falls back for tests/scripts.
 * @returns {string}
 */
function getLogPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'analytics.jsonl');
  } catch {
    const appData = process.env.APPDATA || os.homedir();
    return path.join(appData, 'Typeless', 'analytics.jsonl');
  }
}

// ── Config access ─────────────────────────────────────────────────────────────

/**
 * Safe config getter — returns a default if loader is absent (early bootstrap).
 * @returns {{ localLogEnabled: boolean, retentionDays: number, telemetryEnabled: boolean }}
 */
function getAnalyticsConfig() {
  try {
    const { getConfig } = require('../config/loader');
    const cfg = getConfig();
    return {
      localLogEnabled: cfg.analytics && cfg.analytics.localLogEnabled !== false,
      retentionDays:   (cfg.analytics && cfg.analytics.retentionDays) || 30,
      telemetryEnabled: !!(cfg.telemetry && cfg.telemetry.enabled),
    };
  } catch {
    return { localLogEnabled: true, retentionDays: 30, telemetryEnabled: false };
  }
}

// ── Retention pruning ─────────────────────────────────────────────────────────

/**
 * Prune JSONL entries older than retentionDays.
 * Runs asynchronously; errors are silently swallowed.
 * @param {string} logPath
 * @param {number} retentionDays
 */
function pruneOldEntries(logPath, retentionDays) {
  setImmediate(() => {
    try {
      if (!fs.existsSync(logPath)) return;

      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const raw    = fs.readFileSync(logPath, 'utf8');
      const lines  = raw.split('\n').filter(Boolean);

      const kept = lines.filter((line) => {
        try {
          const entry = JSON.parse(line);
          return typeof entry.ts === 'number' ? entry.ts >= cutoff : true;
        } catch {
          return false; // drop malformed lines
        }
      });

      // Only rewrite if something was actually pruned
      if (kept.length < lines.length) {
        fs.writeFileSync(logPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
      }
    } catch {
      /* best-effort — never surface to caller */
    }
  });
}

// ── Write helpers ─────────────────────────────────────────────────────────────

let _pruneScheduled = false;

/**
 * Append one JSONL entry to the log file.
 * @param {string} logPath
 * @param {string} eventName
 * @param {object} metadata  Already redacted.
 * @param {number} retentionDays
 */
function writeEntry(logPath, eventName, metadata, retentionDays) {
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const entry = JSON.stringify({ ts: Date.now(), event: eventName, ...metadata });
    fs.appendFileSync(logPath, entry + '\n', 'utf8');

    // Prune at most once per process tick batch to avoid thrashing
    if (!_pruneScheduled) {
      _pruneScheduled = true;
      setImmediate(() => {
        _pruneScheduled = false;
        pruneOldEntries(logPath, retentionDays);
      });
    }
  } catch {
    /* fire-and-forget — never propagate write errors */
  }
}

// ── Cloud batching (optional) ─────────────────────────────────────────────────

/**
 * Forward event to batcher.js when telemetry is enabled.
 * Silently skips if batcher is not yet implemented.
 * @param {string} eventName
 * @param {object} metadata  Already redacted.
 */
function forwardToBatcher(eventName, metadata) {
  try {
    const batcher = require('./batcher');
    if (typeof batcher.queue === 'function') {
      batcher.queue(eventName, metadata);
    }
  } catch {
    /* batcher.js optional — silently absent during Phase 0 */
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Emit an analytics event.
 *
 * Fire-and-forget: this function NEVER throws and NEVER returns a Promise.
 * Callers must NOT await it.
 *
 * @param {string} eventName  - One of the EVENTS constants from telemetry/events.js
 * @param {object} [metadata] - Optional safe metadata (no PII — see file header)
 */
function emit(eventName, metadata) {
  // Run all I/O in a future tick so callers are never blocked
  setImmediate(() => {
    try {
      if (typeof eventName !== 'string' || !eventName) return;

      const cfg          = getAnalyticsConfig();
      const safeMetadata = redact(
        metadata !== null && typeof metadata === 'object' ? metadata : {}
      );

      if (cfg.localLogEnabled) {
        const logPath = getLogPath();
        writeEntry(logPath, eventName, safeMetadata, cfg.retentionDays);
      }

      if (cfg.telemetryEnabled) {
        forwardToBatcher(eventName, safeMetadata);
      }
    } catch {
      /* outermost safety net — analytics must NEVER crash the host process */
    }
  });
}

module.exports = { emit };
