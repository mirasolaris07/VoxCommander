'use strict';

/**
 * telemetry/redact.js — PII redaction for log payloads.
 *
 * Phase 0, Step 8.
 *
 * Strips the following categories from any nested object:
 *   audio       — raw PCM / WAV / audio buffer data
 *   text        — transcribed text, typed text, dictated content
 *   keys        — API keys, tokens, secrets, passwords
 *   screenshots — screenshot buffers, image data, bitmaps
 *   credentials — credential names, vault values, vault keys
 *   params      — step params (contain file paths, form values, etc.)
 *   stack       — stack traces (full error detail)
 *
 * Rules:
 *   - Returns a sanitized deep-copy; the original object is NEVER mutated.
 *   - Nested objects are recursively redacted.
 *   - Arrays of primitives are passed through; arrays of objects are mapped.
 *   - Buffer / Uint8Array values in any sensitive field are replaced inline.
 *   - Non-object / null arguments are returned unchanged.
 *   - Circular references are detected and replaced with '[REDACTED:circular]'.
 */

// ── Sensitive field sets ───────────────────────────────────────────────────────

/** Raw audio / PCM data */
const AUDIO_FIELDS = new Set([
  'audio', 'audioBuffer', 'audioData', 'recording', 'pcm',
  'wav', 'rawAudio', 'audioChunk', 'pcmBuffer',
]);

/** Transcribed or typed human text */
const TEXT_FIELDS = new Set([
  'transcript', 'transcription', 'text', 'typedText', 'dictatedText',
  'spokenText', 'utterance', 'content', 'body', 'answer', 'question',
]);

/**
 * API keys, tokens, secrets, passwords.
 * Also catches fields whose names end with 'Key', 'Token', 'Secret', or 'Password'
 * (case-insensitive) — see isSensitiveKey() below.
 */
const KEY_FIELDS = new Set([
  'key', 'apiKey', 'api_key', 'secret', 'token', 'password',
  'accessToken', 'refreshToken', 'bearerToken', 'authToken',
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GROK_API_KEY', 'ELEVENLABS_API_KEY', 'TELEMETRY_API_KEY',
]);

/** Screenshot buffers and raw image data */
const SCREENSHOT_FIELDS = new Set([
  'screenshot', 'screenshotData', 'image', 'imageData',
  'bitmap', 'thumbnail', 'capture', 'rawImage', 'frame',
]);

/** Vault credential names, values, and related identifiers */
const CREDENTIAL_FIELDS = new Set([
  'credentialName', 'credentialValue', 'credential', 'credentialNames',
  'vaultKey', 'vaultValue', 'credentialId',
]);

/** Step params — may contain file paths, form values, typed text, etc. */
const PARAMS_FIELDS = new Set([
  'params', 'stepParams', 'actionParams',
]);

/** Error stack traces */
const STACK_FIELDS = new Set([
  'stack', 'stackTrace',
]);

// ── Redaction labels ───────────────────────────────────────────────────────────

const LABEL = {
  audio:      '[REDACTED:audio]',
  text:       '[REDACTED:text]',
  key:        '[REDACTED:key]',
  screenshot: '[REDACTED:screenshot]',
  credential: '[REDACTED:credential]',
  params:     '[REDACTED:params]',
  stack:      '[REDACTED:stack]',
  binary:     '[REDACTED:binary]',
  circular:   '[REDACTED:circular]',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Return true if the field name looks like an API key/token/secret/password
 * by suffix matching (case-insensitive), even when not in the static set.
 * Examples: 'geminiApiKey', 'openai_token', 'myPassword' all match.
 * @param {string} name
 * @returns {boolean}
 */
function isSensitiveKey(name) {
  if (KEY_FIELDS.has(name)) return true;
  const lower = name.toLowerCase();
  return (
    lower.endsWith('apikey') ||
    lower.endsWith('api_key') ||
    lower.endsWith('token') ||
    lower.endsWith('secret') ||
    lower.endsWith('password') ||
    lower.endsWith('_key') ||
    lower.endsWith('authkey')
  );
}

/**
 * Determine the redaction label for a given field name.
 * Returns null if the field is not sensitive.
 * @param {string} name
 * @returns {string|null}
 */
function labelFor(name) {
  if (AUDIO_FIELDS.has(name))      return LABEL.audio;
  if (TEXT_FIELDS.has(name))       return LABEL.text;
  if (SCREENSHOT_FIELDS.has(name)) return LABEL.screenshot;
  if (CREDENTIAL_FIELDS.has(name)) return LABEL.credential;
  if (PARAMS_FIELDS.has(name))     return LABEL.params;
  if (STACK_FIELDS.has(name))      return LABEL.stack;
  if (isSensitiveKey(name))        return LABEL.key;
  return null;
}

/**
 * Return true if the value is a binary buffer (Node.js Buffer or Uint8Array).
 * Any binary value in a non-sensitive field is also redacted.
 * @param {*} value
 * @returns {boolean}
 */
function isBinary(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

// ── Core recursive redactor ────────────────────────────────────────────────────

/**
 * Internal recursive implementation.
 * @param {*}      value   - The value to sanitize.
 * @param {WeakSet} seen   - Circular reference tracker.
 * @returns {*}
 */
function _redact(value, seen) {
  // Primitives and null — pass through
  if (value === null || typeof value !== 'object') return value;

  // Circular reference guard
  if (seen.has(value)) return LABEL.circular;
  seen.add(value);

  // Arrays — map elements
  if (Array.isArray(value)) {
    const result = value.map((item) => _redact(item, seen));
    seen.delete(value);
    return result;
  }

  // Plain objects
  const out = {};
  for (const key of Object.keys(value)) {
    const raw   = value[key];
    const label = labelFor(key);

    if (label !== null) {
      // Sensitive field — always replace regardless of value type
      out[key] = label;
    } else if (isBinary(raw)) {
      // Binary data in a non-sensitive field — still strip it
      out[key] = LABEL.binary;
    } else {
      // Recurse into nested objects / arrays
      out[key] = _redact(raw, seen);
    }
  }

  seen.delete(value);
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return a sanitized deep-copy of `obj` with all PII fields replaced.
 * Non-object arguments are returned as-is.
 *
 * @param {*} obj - Any value (usually a log payload object)
 * @returns {*}   Sanitized copy, or the original if it is not an object
 */
function redact(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return _redact(obj, new WeakSet());
}

module.exports = { redact };
