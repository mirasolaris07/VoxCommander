'use strict';

/**
 * telemetry/events.js — All 17 analytics event name constants.
 *
 * Phase 0, Step 7.
 * Import this module everywhere. NEVER hardcode event strings directly.
 *
 * Usage:
 *   const { EVENTS } = require('./telemetry/events');
 *   analytics.emit(EVENTS.APP_STARTED, { version: '1.0.0' });
 */

const EVENTS = Object.freeze({
  // ── main.js ────────────────────────────────────────────────────────────────
  APP_STARTED:           'app.started',
  APP_QUIT:              'app.quit',
  ERROR_UNHANDLED:       'error.unhandled',

  // ── voice/recorder.js ──────────────────────────────────────────────────────
  RECORDING_STARTED:     'recording.started',
  RECORDING_STOPPED:     'recording.stopped',

  // ── voice/transcriber.js ───────────────────────────────────────────────────
  TRANSCRIPTION_COMPLETED: 'transcription.completed',

  // ── agent/classifier.js ────────────────────────────────────────────────────
  INTENT_CLASSIFIED:     'intent.classified',

  // ── agent/planner.js ───────────────────────────────────────────────────────
  PLAN_CREATED:          'plan.created',

  // ── agent/executor.js ──────────────────────────────────────────────────────
  PLAN_STARTED:          'plan.started',
  PLAN_COMPLETED:        'plan.completed',
  PLAN_ABORTED:          'plan.aborted',
  STEP_EXECUTED:         'step.executed',
  STEP_FAILED:           'step.failed',

  // ── undo/manager.js ────────────────────────────────────────────────────────
  UNDO_TRIGGERED:        'undo.triggered',

  // ── ui/settings.js ─────────────────────────────────────────────────────────
  SETTINGS_CHANGED:      'settings.changed',

  // ── ui/onboarding.js (fires once, gated on runtime.store flag) ────────────
  ONBOARDING_COMPLETED:  'onboarding.completed',

  // ── scheduler/index.js (addon) ─────────────────────────────────────────────
  SCHEDULED_TASK_RAN:    'scheduled.task.ran',
});

module.exports = { EVENTS };
