'use strict';

/**
 * agent/classifier.js — Intent classifier for transcribed text.
 *
 * Phase 2, Step 22.
 *
 * Maps a transcript string to one of five intents:
 *   dictate   — type the text at cursor (default)
 *   undo      — route to undo/manager.js (highest priority)
 *   command   — reserved for Phase 6; MVP falls back to dictate
 *   code      — code generation; MVP falls back to dictate
 *   secret    — retrieve vault credential and type it
 *
 * Secret extraction:
 *   Strips leading action verbs / possessives from the transcript and returns
 *   the remaining noun phrase as the vault key.
 *   Examples:
 *     "type my GitHub password"  → credentialName: "GitHub password"
 *     "enter my API key"         → credentialName: "API key"
 *     "use my work email"        → credentialName: "work email"
 *
 * Usage:
 *   const { classify } = require('./agent/classifier');
 *   const { intent, credentialName } = classify('type my GitHub password');
 */

// ── Undo triggers (highest priority) ─────────────────────────────────────────

const UNDO_PHRASES = [
  /^undo\s*(that)?$/i,
  /^undo\s*(the\s+)?last\s*(action|step|command|thing)?/i,
  /^revert\s*(that)?$/i,
  /^go\s+back$/i,
  /^ctrl\s*[+\-]\s*z$/i,
];

// ── Secret triggers ───────────────────────────────────────────────────────────

/** Regex to detect "type/enter/paste/fill/insert … my …" secret intent. */
const SECRET_PATTERN = /^(?:type|enter|paste|fill\s*in?|insert|use|put\s*in)\s+my\s+(.+)/i;

// ── Code triggers ─────────────────────────────────────────────────────────────

const CODE_PHRASES = [
  /^write\s+(me\s+)?(?:a\s+|some\s+)?(?:code|function|class|method|script)\b/i,
  /^generate\s+(?:a\s+|some\s+)?(?:code|function|class|method|snippet)\b/i,
  /^code\s+(me\s+)?(?:a\s+)?/i,
  /^implement\s+/i,
  /^refactor\s+/i,
  /^debug\s+(?:this|the)\s+/i,
];

// ── Command triggers ──────────────────────────────────────────────────────────

const COMMAND_PHRASES = [
  /^(?:run|execute|open|launch|close|quit|kill)\s+/i,
  /^(?:git|npm|pip|python|node|bash|powershell|cmd)\s+/i,
];

// ── Credential name extraction ────────────────────────────────────────────────

/**
 * Extract the credential name from a "type my X" style transcript.
 * Strips action verbs, "my", and possessives.
 * @param {string} transcript
 * @returns {string} The vault key
 */
function extractCredentialName(transcript) {
  const m = SECRET_PATTERN.exec(transcript);
  if (!m) return transcript;

  let name = m[1].trim();

  // Remove trailing filler ("please", "now", "for me")
  name = name.replace(/\s*(please|now|for me|thanks?)\.?$/i, '').trim();

  return name;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {{ intent: 'dictate'|'undo'|'command'|'code'|'secret', credentialName?: string }} Classification
 */

/**
 * Classify a transcribed text string into one of the five intents.
 * Undo is checked first (highest priority).
 *
 * @param {string} transcript
 * @returns {Classification}
 */
function classify(transcript) {
  if (typeof transcript !== 'string' || !transcript.trim()) {
    return { intent: 'dictate' };
  }

  const t = transcript.trim();

  // 1. Undo — highest priority
  for (const pattern of UNDO_PHRASES) {
    if (pattern.test(t)) return { intent: 'undo' };
  }

  // 2. Secret
  if (SECRET_PATTERN.test(t)) {
    return { intent: 'secret', credentialName: extractCredentialName(t) };
  }

  // 3. Code
  for (const pattern of CODE_PHRASES) {
    if (pattern.test(t)) return { intent: 'code' };
  }

  // 4. Command (reserved — MVP falls back to dictate)
  for (const pattern of COMMAND_PHRASES) {
    if (pattern.test(t)) return { intent: 'command' };
  }

  // 5. Default: dictate
  return { intent: 'dictate' };
}

module.exports = { classify };
