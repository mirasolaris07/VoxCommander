'use strict';

/**
 * telemetry/logger.js — electron-log wrapper
 *
 * Phase 0, Step 6.
 * - Log rotation: 10 MB per file, retain up to 5 rotated archives.
 * - redact() is called on every object argument before the message is written,
 *   stripping audio, text, keys, screenshots, and credential names (PII).
 *
 * Usage:
 *   const log = require('./telemetry/logger');
 *   log.info('app started', { version: '1.0.0' });
 *
 * Levels (low → high): silly | debug | verbose | info | warn | error
 */

const path = require('path');
const fs = require('fs');
const electronLog = require('electron-log');
const { redact } = require('./redact');

// ── Rotation settings ────────────────────────────────────────────────────────

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

electronLog.transports.file.maxSize = MAX_SIZE_BYTES;

/**
 * Custom archive function: shift existing numbered backups up by one,
 * drop the oldest if the cap is reached, then rename the current log.
 *
 * Result after rotation with MAX_FILES=5:
 *   typeless.log          ← new (fresh, empty)
 *   typeless.1.log        ← most recent archive
 *   typeless.2.log
 *   typeless.3.log
 *   typeless.4.log        ← oldest archive (typeless.5.log would have been deleted)
 *
 * @param {object|string} oldLogFile - Path-like object from electron-log
 */
electronLog.transports.file.archiveLog = function archiveLog(oldLogFile) {
  const logPath = oldLogFile.toString();
  const dir = path.dirname(logPath);
  const ext = path.extname(logPath);
  const base = path.basename(logPath, ext);

  // Delete the oldest archive if we are at the cap
  const oldest = path.join(dir, `${base}.${MAX_FILES - 1}${ext}`);
  if (fs.existsSync(oldest)) {
    try { fs.unlinkSync(oldest); } catch { /* ignore — best effort */ }
  }

  // Shift .N.log → .(N+1).log for N = MAX_FILES-2 down to 1
  for (let i = MAX_FILES - 2; i >= 1; i--) {
    const from = path.join(dir, `${base}.${i}${ext}`);
    const to   = path.join(dir, `${base}.${i + 1}${ext}`);
    if (fs.existsSync(from)) {
      try { fs.renameSync(from, to); } catch { /* ignore */ }
    }
  }

  // Rename the just-rotated log to .1.log
  const firstArchive = path.join(dir, `${base}.1${ext}`);
  try { fs.renameSync(logPath, firstArchive); } catch { /* ignore */ }
};

// ── PII redaction hook ───────────────────────────────────────────────────────

/**
 * Before any transport writes the message, redact() is called on every
 * object argument to strip PII (audio buffers, transcribed text, API keys,
 * screenshots, credential names, etc.).
 * Primitive arguments (strings, numbers) are passed through unchanged.
 */
electronLog.hooks.push((message) => {
  if (Array.isArray(message.data)) {
    message.data = message.data.map((item) => {
      if (item !== null && typeof item === 'object') {
        return redact(item);
      }
      return item;
    });
  }
  return message;
});

module.exports = electronLog;
