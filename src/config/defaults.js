'use strict';

/**
 * System-denied paths — hardcoded, users cannot remove these via settings.
 * pathGuard.js expands %APPDATA% / %USERPROFILE% before exact-matching against this list.
 */
const SYSTEM_DENIED_PATHS = [
  'C:\\Windows',
  'C:\\Windows\\System32',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  '%APPDATA%\\Microsoft',
  '%USERPROFILE%\\.ssh',
  '%USERPROFILE%\\.gnupg',
  '%USERPROFILE%\\.aws',
  '%USERPROFILE%\\.config\\gcloud',
  '%APPDATA%\\Roaming\\Microsoft\\Credentials',
  '%APPDATA%\\Typeless\\.env',
];

/**
 * Application-wide default configuration — Layer 1 of the 3-layer config merge.
 *
 * 3-layer merge order (last wins):
 *   Layer 1 — DEFAULTS (this file)
 *   Layer 2 — User overrides in %APPDATA%/Typeless/app.config.json
 *   Layer 3 — .env secrets in process.env
 *
 * All 42 keys here are reflected in app.config.schema.json.
 * Keys are grouped by namespace (hotkey / voice / agent / ui / sandbox / tts / scheduler / telemetry / analytics / logging).
 */
const DEFAULTS = {
  // ── hotkey (4 keys) ────────────────────────────────────────────────────────
  hotkey: {
    /** Hold → speak → release → types transcription at cursor */
    dictate: 'Ctrl+Space',
    /** Hold → speak → release → AI generates action plan → review → run */
    plan: 'Ctrl+Shift+Space',
    /** Globally cancels the current in-flight operation — no-op when idle, routes by _currentState */
    abort: 'Alt+Shift+Escape',
    /** 10-second timed undo window — armed only after an action completes */
    undo: 'Alt+Z',
  },

  // ── voice (10 keys) ────────────────────────────────────────────────────────
  voice: {
    /**
     * AI provider used for speech-to-text transcription.
     *   gemini  — Gemini multimodal API           (requires GEMINI_API_KEY)
     *   openai  — OpenAI Whisper                  (requires OPENAI_API_KEY)
     *   grok    — xAI Grok (OpenAI-compatible)    (requires GROK_API_KEY)
     *   claude  — Gemini/OpenAI raw STT + Claude cleanup pass
     *             (requires ANTHROPIC_API_KEY + at least one of GEMINI/OPENAI/GROK key)
     *   local   — whisper.cpp binary (addon, Phase 6)
     */
    provider: 'gemini', // gemini | openai | grok | claude | local
    /** BCP-47 language tag forwarded to the transcription API */
    language: 'en',
    /** Milliseconds of silence before auto-stop while recording */
    silenceThresholdMs: 1500,
    /** Addon: keep recording after first silence (step 61) */
    continuousMode: false,
    /** Hard auto-stop guard regardless of silence detection */
    maxRecordingSeconds: 60,
    /** Milliseconds to keep capturing after stop() is called (push-to-talk key release)
     *  to avoid cutting off the last syllable before SoX is killed */
    trailingMs: 200,
    /** Minimum recording duration in milliseconds — recordings shorter than this
     *  are rejected with EMPTY_TRANSCRIPT shown in the HUD (not sent to the API) */
    minRecordingMs: 500,
    /** Gemini model for audio transcription */
    geminiModel: 'gemini-2.5-flash-lite',
    /** OpenAI model for audio transcription (Whisper) */
    openaiModel: 'whisper-1',
    /** Grok model for audio transcription (OpenAI-compatible Whisper) */
    grokModel: 'whisper-1',
    /** Claude model used for the cleanup pass in claude provider mode */
    claudeModel: 'claude-haiku-4-5-20251001',
    /** Milliseconds before transcription API call times out */
    transcriptionTimeoutMs: 10000,
  },

  // ── agent (11 keys) ────────────────────────────────────────────────────────
  agent: {
    /** AI provider used for plan generation */
    plannerProvider: 'gemini', // gemini | grok | openai | anthropic
    /** Model identifier for the planner provider */
    plannerModel: 'gemini-2.5-flash-lite',
    /** AI provider used for screenshot vision analysis */
    visionProvider: 'gemini', // gemini | openai
    /** false = no vision API calls at all */
    visionEnabled: true,
    /** Pause and show plan preview before executing */
    confirmBeforeExecute: true,
    /** Plans exceeding this step count are rejected by validator.js */
    maxSteps: 20,
    /** Max retries per failed step before surfacing error to user */
    stepRetries: 1,
    /** Hard cap on total API requests per minute — 60s cooldown if exceeded */
    maxRequestsPerMinute: 20,
    /** Shared cap for plan gen + edit re-inference + clarification re-plans */
    maxPlanRequestsPerMinute: 5,
    /** Enable code-mode system prompt for the planner */
    codeMode: true,
    /** Insert code results via clipboard paste instead of keyboard.type() */
    codeInsertViaClipboard: true,
  },

  // ── ui (6 keys) ────────────────────────────────────────────────────────────
  ui: {
    /** Restore focus to _targetHwnd after plan execution completes */
    restoreFocusAfter: true,
    /** Show per-step progress indicator in the HUD during execution */
    showStepProgress: true,
    /** Milliseconds delay between typed characters; 0 = instant */
    typingSpeed: 0,
    /** HUD overlay anchor position on screen */
    hudPosition: 'bottom-center', // bottom-center | bottom-right | top-center
    /** App names that always block cloud AI calls (sensitive context enforcement) */
    sensitiveContextApps: [],
    /** Fade the HUD pill to 30% opacity after 5 s of idle */
    pillFadeOnIdle: true,
  },

  // ── sandbox (7 keys) ───────────────────────────────────────────────────────
  sandbox: {
    /** Paths the agent is permitted to write files to */
    allowedWritePaths: ['~/Documents/Typeless'],
    /** Paths the agent is permitted to read files from */
    allowedReadPaths: ['~/Documents/Typeless', '~/Desktop'],
    /** User-defined extra denied paths — merged with SYSTEM_DENIED_PATHS at runtime */
    deniedPaths: [],
    /** Allowlisted shell commands: [{name, path, allowedArgs?, workingDir?}] */
    allowedCommands: [],
    /** Allow plan steps to delete files */
    allowDelete: false,
    /** Allow plan steps to invoke shell commands via runCommand */
    allowShellExec: false,
    /** Allow plan steps to overwrite existing files */
    allowOverwrite: false,
  },

  // ── tts (2 keys) ───────────────────────────────────────────────────────────
  tts: {
    /** Enable text-to-speech readback of completed actions */
    enabled: false,
    /**
     * TTS engine to use.
     * NOTE: 'say' package is not installed until step 64 — safe only because tts.enabled defaults false.
     */
    provider: 'say', // say | elevenlabs
  },

  // ── scheduler (1 key) ──────────────────────────────────────────────────────
  scheduler: {
    /** Enable scheduled / recurring plan execution */
    enabled: false,
  },

  // ── telemetry (1 key) ──────────────────────────────────────────────────────
  telemetry: {
    /** Send anonymous usage telemetry to the Typeless team */
    enabled: false,
  },

  // ── analytics (2 keys) ─────────────────────────────────────────────────────
  analytics: {
    /** Write structured event log to local disk */
    localLogEnabled: true,
    /** Days to retain local analytics logs before pruning */
    retentionDays: 30,
  },

  // ── logging (3 keys) ───────────────────────────────────────────────────────
  logging: {
    /** Winston log level for the main process */
    level: 'info', // error | warn | info | debug
    /** Maximum size of a single log file in megabytes before rotation */
    maxFileSizeMb: 10,
    /** Number of rotated log files to retain */
    maxFiles: 5,
  },
};

module.exports = { DEFAULTS, SYSTEM_DENIED_PATHS };
