// ==========================================================================
//  src/progression.js
//  Gravity, lock delay and scoring (SPEC §6.3, §8). Level functions arrive in M4.
//  Pure, no DOM.
// ==========================================================================

import { MAX_LEVEL, LOCK_DELAY_FRAMES } from './config.js';

/**
 * Tolerance for the gravity accumulator: step a row when
 * `gravityAcc >= 1 - GRAVITY_EPSILON`. Summing 1/framesPerRow in floating
 * point lands just below 1.0 on several NES levels (SPEC §8.1).
 */
export const GRAVITY_EPSILON = 1e-9;

// NES frames per row for levels 0–29.
const NES_FRAMES_PER_ROW = [
  48, 43, 38, 33, 28, 23, 18, 13, 8, 6, //  0–9
  5, 5, 5, 4, 4, 4, 3, 3, 3, 2,         // 10–19
  2, 2, 2, 2, 2, 2, 2, 2, 2, 1,         // 20–29
];

// Levels 30–99: linear ramp from 1 G (level 29) to 20 G (level 99).
const RAMP_START = 29;
const RAMP_END = 99;
const MAX_G = 20;

/** @returns {number} rows per frame (G) for a level, clamped to 0..MAX_LEVEL. */
export function getGravity(level) {
  const l = Number.isFinite(level) ? Math.min(MAX_LEVEL, Math.max(0, Math.floor(level))) : 0;
  if (l < NES_FRAMES_PER_ROW.length) return 1 / NES_FRAMES_PER_ROW[l];
  return 1 + ((l - RAMP_START) * (MAX_G - 1)) / (RAMP_END - RAMP_START);
}

// ---------------------------------------------------------------------------
// Lock delay (SPEC §8.1)
// ---------------------------------------------------------------------------

const LOCK_DELAY_MIN = 12;   // frames at level 99 (LOCK_DELAY_FRAMES through level 29)

/** @returns {number} frames a grounded piece waits before locking. */
export function getLockDelay(level) {
  const l = Number.isFinite(level) ? Math.min(MAX_LEVEL, Math.max(0, Math.floor(level))) : 0;
  if (l <= RAMP_START) return LOCK_DELAY_FRAMES;
  const t = (l - RAMP_START) / (RAMP_END - RAMP_START);
  return Math.round(LOCK_DELAY_FRAMES - t * (LOCK_DELAY_FRAMES - LOCK_DELAY_MIN));
}

// ---------------------------------------------------------------------------
// Scoring (SPEC §8.3, NES)
// ---------------------------------------------------------------------------

export const SOFT_DROP_POINTS = 1;   // per row moved while soft-dropping
export const HARD_DROP_POINTS = 2;   // per row of a hard drop

const LINE_CLEAR_POINTS = [0, 40, 100, 300, 1200];

/** @returns {number} points for clearing `lineCount` rows at `level` (level before the clear). */
export function scoreForClear(lineCount, level) {
  const base = LINE_CLEAR_POINTS[lineCount] ?? 0;
  return base * (Math.max(0, Math.floor(level)) + 1);
}
