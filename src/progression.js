// ==========================================================================
//  src/progression.js
//  Gravity curve (SPEC §6.3, §8.1). Level/score functions arrive in M4.
//  Pure, no DOM.
// ==========================================================================

import { MAX_LEVEL } from './config.js';

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
