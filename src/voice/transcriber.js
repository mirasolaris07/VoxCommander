'use strict';

/**
 * voice/transcriber.js — WAV buffer → transcribed text.
 *
 * Phase 2, Step 21.
 *
 * Supported voice.provider values:
 *   gemini   — Gemini multimodal API (base64 inline audio)
 *   openai   — OpenAI Whisper API (multipart/form-data)
 *   grok     — xAI Grok API (OpenAI-compatible audio endpoint)
 *   claude   — Two-phase: raw STT via Gemini/OpenAI, then Claude cleanup pass
 *   local    — whisper.cpp binary (addon — Phase 6, Step 63)
 *
 * Provider selection: set voice.provider in app.config.json.
 * API key env vars:
 *   GEMINI_API_KEY, OPENAI_API_KEY, GROK_API_KEY, ANTHROPIC_API_KEY
 *
 * Model names and timeout come from config (voice.geminiModel, voice.openaiModel,
 * voice.grokModel, voice.claudeModel, voice.transcriptionTimeoutMs).
 *
 * Error codes emitted:
 *   TRANSCRIPTION_TIMEOUT   — API took > transcriptionTimeoutMs
 *   TRANSCRIPTION_API_ERROR — 4xx / 5xx or missing API key
 *   EMPTY_TRANSCRIPT        — API returned blank string
 *   RATE_LIMITED            — 429 response
 *
 * Usage:
 *   const transcriber = require('./voice/transcriber');
 *   const text = await transcriber.transcribe(wavBuffer);
 *   transcriber.abort(); // cancels in-flight request
 */

const { getConfig } = require('../config/loader');

// ── AbortController ───────────────────────────────────────────────────────────

let _controller = null;

/** Cancel any in-flight transcription request. */
function abort() {
  if (_controller) { _controller.abort(); _controller = null; }
}

// ── Error factory ─────────────────────────────────────────────────────────────

function apiError(code, message, cause) {
  const err  = new Error(message || code);
  err.code   = code;
  if (cause) err.cause = cause;
  return err;
}

// ── Multipart form-data builder (shared by OpenAI + Grok) ────────────────────

function buildAudioFormData(wavBuffer, boundary, modelName) {
  const CRLF = '\r\n';
  const preamble = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="model"',
    '',
    modelName,
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="audio.wav"',
    'Content-Type: audio/wav',
    '',
  ].join(CRLF);

  const epilogue = `${CRLF}--${boundary}--${CRLF}`;

  return Buffer.concat([
    Buffer.from(preamble + CRLF),
    wavBuffer,
    Buffer.from(epilogue),
  ]);
}

// ── Gemini ────────────────────────────────────────────────────────────────────

async function transcribeGemini(wavBuffer, language, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw apiError('TRANSCRIPTION_API_ERROR', 'GEMINI_API_KEY not set');

  const cfg   = getConfig();
  const model = (cfg.voice && cfg.voice.geminiModel) || 'gemini-2.5-flash-lite';
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: 'audio/wav', data: wavBuffer.toString('base64') } },
        { text: `Transcribe the audio exactly. Return only the spoken words in ${language || 'en'}, nothing else.` },
      ],
    }],
    generationConfig: { temperature: 0 },
  });

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
  if (res.status === 429) throw apiError('RATE_LIMITED', 'Gemini rate limit hit');
  if (!res.ok)           throw apiError('TRANSCRIPTION_API_ERROR', `Gemini HTTP ${res.status}`);

  const json = await res.json();
  const text = (json?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  if (!text) throw apiError('EMPTY_TRANSCRIPT', 'Gemini returned empty transcription');

  // Detect model refusal — Gemini returns a polite refusal as non-empty text
  // when audio is too short, silent, or unintelligible.
  // Pass the actual Gemini message (truncated) so the HUD shows the real reason.
  const lower = text.toLowerCase();
  const isRefusal =
    lower.startsWith("i'm sorry") ||
    lower.startsWith('i cannot') ||
    lower.startsWith("i'm unable") ||
    lower.startsWith('i am unable') ||
    lower.startsWith('sorry,') ||
    lower.includes('no discernible') ||
    lower.includes('no spoken words') ||
    lower.includes('audio is silent') ||
    lower.includes('audio provided is') ||
    lower.includes('no speech detected') ||
    lower.includes('does not contain') ||
    lower.includes('cannot transcribe');
  if (isRefusal) {
    const reason = text.length > 140 ? text.slice(0, 140) + '…' : text;
    throw apiError('EMPTY_TRANSCRIPT', reason);
  }

  return text;
}

// ── OpenAI Whisper ────────────────────────────────────────────────────────────

async function transcribeOpenAI(wavBuffer, language, signal) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw apiError('TRANSCRIPTION_API_ERROR', 'OPENAI_API_KEY not set');

  const cfg       = getConfig();
  const modelName = (cfg.voice && cfg.voice.openaiModel) || 'whisper-1';

  return _whisperCompatible(
    wavBuffer, language, signal, modelName,
    'https://api.openai.com/v1/audio/transcriptions',
    `Bearer ${apiKey}`
  );
}

// ── Grok (xAI — OpenAI-compatible audio endpoint) ────────────────────────────
//
// xAI's API is fully OpenAI-compatible. Audio transcription is available at
// https://api.x.ai/v1/audio/transcriptions using the same multipart/form-data
// format as OpenAI Whisper. API key comes from GROK_API_KEY env var.

async function transcribeGrok(wavBuffer, language, signal) {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) throw apiError('TRANSCRIPTION_API_ERROR', 'GROK_API_KEY not set');

  const cfg       = getConfig();
  const modelName = (cfg.voice && cfg.voice.grokModel) || 'whisper-1';

  return _whisperCompatible(
    wavBuffer, language, signal, modelName,
    'https://api.x.ai/v1/audio/transcriptions',
    `Bearer ${apiKey}`
  );
}

// ── Shared Whisper-compatible multipart helper ────────────────────────────────

async function _whisperCompatible(wavBuffer, language, signal, modelName, url, authHeader) {
  const boundary = `----FormBoundary${Date.now()}`;
  let body;

  if (language && language !== 'en') {
    body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${modelName}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      ),
      wavBuffer,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n--${boundary}--\r\n`
      ),
    ]);
  } else {
    body = buildAudioFormData(wavBuffer, boundary, modelName);
  }

  const res = await fetch(url, {
    method:  'POST',
    headers: { Authorization: authHeader, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal,
  });

  if (res.status === 429) throw apiError('RATE_LIMITED', `Rate limit hit (${url})`);
  if (!res.ok)           throw apiError('TRANSCRIPTION_API_ERROR', `HTTP ${res.status} from ${url}`);

  const json = await res.json();
  const text = (json?.text || '').trim();
  if (!text) throw apiError('EMPTY_TRANSCRIPT', 'API returned empty transcription');
  return text;
}

// ── Claude (two-phase: raw STT → Claude cleanup) ──────────────────────────────
//
// Anthropic's Claude API does not support audio input directly.
// This provider uses the best available STT (Gemini → OpenAI → error) to
// get a raw transcript, then sends it through Claude's Messages API for
// cleanup: fixing punctuation, formatting, and correcting homophones.
//
// Set voice.provider = 'claude' when you want Claude-quality text post-processing
// on top of raw transcription.

async function transcribeClaude(wavBuffer, language, signal) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw apiError('TRANSCRIPTION_API_ERROR', 'ANTHROPIC_API_KEY not set');

  // Phase 1 — raw STT via best available provider
  let rawText = '';
  const rawErrors = [];

  if (process.env.GEMINI_API_KEY) {
    try { rawText = await transcribeGemini(wavBuffer, language, signal); }
    catch (e) { rawErrors.push(`gemini: ${e.message}`); }
  }

  if (!rawText && process.env.OPENAI_API_KEY) {
    try { rawText = await transcribeOpenAI(wavBuffer, language, signal); }
    catch (e) { rawErrors.push(`openai: ${e.message}`); }
  }

  if (!rawText && process.env.GROK_API_KEY) {
    try { rawText = await transcribeGrok(wavBuffer, language, signal); }
    catch (e) { rawErrors.push(`grok: ${e.message}`); }
  }

  if (!rawText) {
    throw apiError(
      'TRANSCRIPTION_API_ERROR',
      `Claude provider requires a raw STT key (GEMINI_API_KEY, OPENAI_API_KEY, or GROK_API_KEY). ` +
      `Errors: ${rawErrors.join('; ')}`
    );
  }

  // Phase 2 — Claude cleanup pass
  try {
    const cfg   = getConfig();
    const model = (cfg.voice && cfg.voice.claudeModel) || 'claude-haiku-4-5-20251001';

    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content:
          `You are a voice transcription cleanup assistant.\n` +
          `The following text was produced by an automated speech-to-text engine. ` +
          `Fix any obvious transcription errors (punctuation, formatting, homophones) ` +
          `without changing the meaning or adding content.\n` +
          `Return ONLY the cleaned transcript — no explanation.\n\n` +
          `Raw transcript:\n${rawText}`,
      }],
    });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body,
      signal,
    });

    if (res.status === 429) throw apiError('RATE_LIMITED', 'Claude rate limit hit');
    if (!res.ok)           throw apiError('TRANSCRIPTION_API_ERROR', `Claude HTTP ${res.status}`);

    const json    = await res.json();
    const cleaned = (json?.content?.[0]?.text || '').trim();
    return cleaned || rawText; // fall back to raw if Claude returns empty
  } catch (err) {
    if (err.code) throw err;
    // Claude cleanup failed — return raw transcript rather than failing the whole request
    console.warn('[transcriber] Claude cleanup failed, using raw transcript:', err.message);
    return rawText;
  }
}

// ── Local Whisper (addon — Phase 6, Step 63) ──────────────────────────────────

async function transcribeLocal(wavBuffer, language, signal) {
  const { execFile } = require('child_process');
  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const binaryPath = process.env.WHISPER_LOCAL_PATH;
  const modelPath  = process.env.WHISPER_LOCAL_MODEL;
  if (!binaryPath || !modelPath) {
    throw apiError('TRANSCRIPTION_API_ERROR', 'WHISPER_LOCAL_PATH / WHISPER_LOCAL_MODEL not set');
  }

  const cfg        = getConfig();
  const timeoutMs  = (cfg.voice && cfg.voice.transcriptionTimeoutMs) || 10000;
  const tmpPath    = path.join(os.tmpdir(), `typeless-${Date.now()}.wav`);

  try {
    fs.writeFileSync(tmpPath, wavBuffer);
    const stdout = await new Promise((resolve, reject) => {
      execFile(binaryPath, ['-m', modelPath, '-f', tmpPath, '-l', language || 'en', '--output-txt'],
        { timeout: timeoutMs },
        (err, out) => err ? reject(err) : resolve(out)
      );
    });
    const text = (stdout || '').trim();
    if (!text) throw apiError('EMPTY_TRANSCRIPT', 'Local whisper returned empty result');
    return text;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
  }
}

// ── Main transcribe ───────────────────────────────────────────────────────────

/**
 * Transcribe a WAV buffer to text using the configured voice.provider.
 *
 * Provider routing:
 *   gemini  → Gemini multimodal API
 *   openai  → OpenAI Whisper
 *   grok    → xAI Grok (OpenAI-compatible)
 *   claude  → Gemini/OpenAI raw STT + Claude cleanup
 *   local   → whisper.cpp binary
 *
 * @param {Buffer} wavBuffer
 * @returns {Promise<string>}
 */
async function transcribe(wavBuffer) {
  if (!wavBuffer || wavBuffer.length < 44) {
    throw apiError('EMPTY_TRANSCRIPT', 'WAV buffer too small');
  }

  const cfg      = getConfig();
  const provider = (cfg.voice && cfg.voice.provider) || 'gemini';
  const language = (cfg.voice && cfg.voice.language) || 'en';
  const timeout  = (cfg.voice && cfg.voice.transcriptionTimeoutMs) || 10000;

  abort(); // cancel any stale request
  _controller = new AbortController();
  const { signal } = _controller;

  const timeoutHandle = setTimeout(() => { if (_controller) _controller.abort(); }, timeout);

  try {
    let text;
    switch (provider) {
      case 'gemini': text = await transcribeGemini(wavBuffer, language, signal); break;
      case 'openai': text = await transcribeOpenAI(wavBuffer, language, signal); break;
      case 'grok':   text = await transcribeGrok(wavBuffer, language, signal);   break;
      case 'claude': text = await transcribeClaude(wavBuffer, language, signal); break;
      case 'local':  text = await transcribeLocal(wavBuffer, language, signal);  break;
      default:
        throw apiError('TRANSCRIPTION_API_ERROR', `Unknown voice.provider: "${provider}". Use gemini | openai | grok | claude | local`);
    }
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw apiError('TRANSCRIPTION_TIMEOUT', 'Transcription timed out or was aborted');
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    _controller = null;
  }
}

module.exports = { transcribe, abort };
