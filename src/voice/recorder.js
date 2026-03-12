'use strict';

/**
 * voice/recorder.js — 16 kHz mono PCM audio recorder.
 *
 * Phase 2, Step 20.
 *
 * On Windows: spawns SoX directly with -t waveaudio default.
 *   node-record-lpcm16 uses --default-device which Windows SoX does not support.
 * On macOS/Linux: uses node-record-lpcm16 (--default-device works there).
 *
 * Recording stops when EITHER:
 *   (a) stop() / cancel() is called (push-to-talk key release)
 *   (b) Silence detected for silenceThresholdMs consecutive ms (fallback)
 *   (c) maxRecordingSeconds is exceeded (hard auto-stop)
 *
 * Usage:
 *   const recorder = require('./voice/recorder');
 *   const wavBuffer = await recorder.start('dictate');
 *   recorder.stop();   // resolves with WAV Buffer
 *   recorder.cancel(); // resolves with null
 */

const { getConfig }   = require('../config/loader');
const { spawn }       = require('child_process');
const os              = require('os');
const path            = require('path');
const fs              = require('fs');

const IS_WIN = os.platform() === 'win32';

// ── SoX binary resolution (Windows) ──────────────────────────────────────────

function findSoxExe() {
  // 1. Already on PATH?
  const { execSync } = require('child_process');
  try {
    const which = execSync('where sox', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const p = which.trim().split(/\r?\n/)[0];
    if (p && fs.existsSync(p)) return p;
  } catch { /* not on PATH */ }

  // 2. Known install locations
  const candidates = [
    'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe',
    'C:\\Program Files\\sox-14-4-2\\sox.exe',
    'C:\\Program Files (x86)\\SoX\\sox.exe',
    'C:\\Program Files\\SoX\\sox.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SAMPLE_RATE           = 16000;
const CHANNELS              = 1;
const BIT_DEPTH             = 16;
const SILENCE_RMS_THRESHOLD = 0.01;

// ── State ─────────────────────────────────────────────────────────────────────

let _state         = 'idle';
let _resolve       = null;
let _reject        = null;
let _chunks        = [];
let _proc          = null;   // ChildProcess (Windows) or node-record-lpcm16 object
let _stream        = null;   // Readable stream of raw PCM
let _autoStopTimer = null;
let _silenceTimer  = null;
let _trailingTimer = null;   // trailing capture window after stop() is called

// ── WAV encoder ───────────────────────────────────────────────────────────────

function encodeWav(pcm, { sampleRate, channels, bitDepth }) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize   = pcm.length;
  const header     = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// ── Silence detection ─────────────────────────────────────────────────────────

function rmsEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function _cleanup() {
  _state  = 'idle';
  _chunks = [];

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  if (_silenceTimer)  { clearTimeout(_silenceTimer);  _silenceTimer  = null; }
  if (_trailingTimer) { clearTimeout(_trailingTimer); _trailingTimer = null; }

  if (_proc) {
    try { _proc.kill(); } catch { /* best-effort */ }
    _proc   = null;
    _stream = null;
  }
}

// ── Finish recording ──────────────────────────────────────────────────────────

function _finishRecording() {
  if (_state !== 'recording') return;
  _state = 'stopping';

  const pcm = Buffer.concat([..._chunks]);
  _cleanup();

  const res = _resolve;
  _resolve  = null;
  _reject   = null;

  // Reject recordings shorter than voice.minRecordingMs (default 500ms).
  // 16kHz 16-bit mono = 32 bytes per ms.
  const cfg2         = getConfig();
  const minMs        = (cfg2.voice && cfg2.voice.minRecordingMs != null) ? cfg2.voice.minRecordingMs : 500;
  const minBytes     = minMs * SAMPLE_RATE * (BIT_DEPTH / 8) * CHANNELS / 1000;
  if (pcm.length < minBytes) {
    if (res) res(null);
    return;
  }

  if (res) res(encodeWav(pcm, { sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: BIT_DEPTH }));
}

// ── Spawn SoX (Windows) ───────────────────────────────────────────────────────

function _spawnSoxWindows(device) {
  const soxExe = findSoxExe();
  if (!soxExe) {
    const e = new Error('NO_AUDIO_DEVICE');
    e.code = 'NO_AUDIO_DEVICE';
    throw e;
  }

  // Use -t waveaudio (Windows native audio driver)
  // -t waveaudio default  → default Windows recording device
  // -t waveaudio "Device Name"  → specific device
  const inputType   = device ? ['-t', 'waveaudio', device] : ['-t', 'waveaudio', 'default'];
  const outputArgs  = [
    '-r', String(SAMPLE_RATE),
    '-c', String(CHANNELS),
    '-e', 'signed-integer',
    '-b', String(BIT_DEPTH),
    '-t', 'raw',
    '-',
  ];

  const proc = spawn(soxExe, [...inputType, ...outputArgs], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return { proc, stream: proc.stdout };
}

// ── Spawn via node-record-lpcm16 (macOS / Linux) ──────────────────────────────

function _spawnCrossplatform(device) {
  const record = require('node-record-lpcm16');
  const rec = record.record({
    sampleRate: SAMPLE_RATE,
    channels:   CHANNELS,
    audioType:  'raw',
    recorder:   'sox',
    silence:    0,
    threshold:  0,
    verbose:    false,
    ...(device ? { device } : {}),
  });
  // node-record-lpcm16 exposes a stop() method on the recording object
  return { proc: rec, stream: rec.stream() };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Begin audio capture.
 * @param {'dictate'|'plan'} mode
 * @returns {Promise<Buffer|null>} WAV buffer, or null if cancelled/empty
 */
function start(mode) {  // eslint-disable-line no-unused-vars
  if (_state !== 'idle') {
    return Promise.reject(new Error('Recorder already active'));
  }

  return new Promise((resolve, reject) => {
    const cfg        = getConfig();
    const silenceMs  = (cfg.voice && cfg.voice.silenceThresholdMs) || 1500;
    const maxSeconds = (cfg.voice && cfg.voice.maxRecordingSeconds) || 60;
    const device     = (cfg.voice && cfg.voice.device) || null;

    _state   = 'recording';
    _resolve = resolve;
    _reject  = reject;
    _chunks  = [];

    // ── Spawn SoX ─────────────────────────────────────────────────────────────
    try {
      if (IS_WIN) {
        const { proc, stream } = _spawnSoxWindows(device);
        _proc   = proc;
        _stream = stream;

        // Capture stderr for error detection
        let stderrBuf = '';
        proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

        proc.on('error', () => {
          if (_state !== 'idle') {
            const rej = _reject;
            _cleanup();
            _resolve = null; _reject = null;
            if (rej) { const e = new Error('NO_AUDIO_DEVICE'); e.code = 'NO_AUDIO_DEVICE'; rej(e); }
          }
        });

        proc.on('close', (code) => {
          if (_state === 'recording' && code !== 0) {
            console.error('[recorder] SoX exited with code', code, stderrBuf.trim());
            const rej = _reject;
            _cleanup();
            _resolve = null; _reject = null;
            if (rej) { const e = new Error('NO_AUDIO_DEVICE'); e.code = 'NO_AUDIO_DEVICE'; rej(e); }
          }
        });
      } else {
        const { proc, stream } = _spawnCrossplatform(device);
        _proc   = proc;
        _stream = stream;
      }
    } catch (err) {
      _state = 'idle';
      reject(err);
      return;
    }

    // ── Data handler (shared) ──────────────────────────────────────────────────
    _stream.on('data', (chunk) => {
      if (_state !== 'recording') return;
      _chunks.push(Buffer.from(chunk));

      const rms = rmsEnergy(chunk);
      if (rms < SILENCE_RMS_THRESHOLD) {
        if (!_silenceTimer) {
          _silenceTimer = setTimeout(() => {
            if (_state === 'recording') _finishRecording();
          }, silenceMs);
        }
      } else {
        if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }
      }
    });

    _stream.on('error', () => {
      if (_state !== 'idle') {
        const rej = _reject;
        _cleanup();
        _resolve = null; _reject = null;
        if (rej) { const e = new Error('NO_AUDIO_DEVICE'); e.code = 'NO_AUDIO_DEVICE'; rej(e); }
      }
    });

    // ── Hard auto-stop ────────────────────────────────────────────────────────
    _autoStopTimer = setTimeout(() => {
      if (_state === 'recording') _finishRecording();
    }, maxSeconds * 1000);
  });
}

/**
 * Stop recording and resolve with the captured WAV buffer.
 * Keeps capturing for voice.trailingMs after key release so the last syllable
 * is not cut off when SoX is killed.
 */
function stop() {
  if (_state !== 'recording') return;
  if (_trailingTimer) return; // already in trailing window

  const cfg       = getConfig();
  const trailingMs = (cfg.voice && cfg.voice.trailingMs != null) ? cfg.voice.trailingMs : 200;

  if (trailingMs <= 0) {
    _finishRecording();
    return;
  }

  // Disable silence auto-stop during the trailing window — we want to keep
  // capturing even if the user went quiet right at key release
  if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }

  _trailingTimer = setTimeout(() => {
    _trailingTimer = null;
    _finishRecording();
  }, trailingMs);
}

/**
 * Cancel recording. Resolves start() with null.
 */
function cancel() {
  if (_state !== 'recording') return;
  _cleanup();
  const res = _resolve;
  _resolve  = null;
  _reject   = null;
  if (res) res(null);
}

module.exports = { start, stop, cancel };
