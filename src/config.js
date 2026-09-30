// ==========================================================================
//  src/config.js
//  All magic numbers for the retro NES-style Tetris live here so the rest of
//  the codebase stays free of literals. Frame counts assume 60 fps.
// ==========================================================================

// Visible playfield dimensions (cells).
export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;

// Rows above the visible field where pieces spawn before dropping into view.
export const HIDDEN_BUFFER = 2;

// Logical pixels per cell. The board canvas is 160×320 = 10×20 cells of 16px.
export const TILE_SIZE = 16;

// Fixed simulation rate.
export const FPS = 60;

// NES gravity table: frames per row for levels 0–29 (the "base speeds").
// Index by level, e.g. GRAVITY_TABLE[0] === 48 frames/row at level 0.
export const GRAVITY_TABLE = [
  48, 43, 38, 33, 28, 23, 18, 13, 8, 6, //  0–9
  5, 5, 4, 4, 4, 3, 3, 3, 2, 2,        // 10–19
  2, 1, 1, 1, 1, 1, 1, 1, 1, 1,        // 20–29
];

export const MAX_LEVEL = GRAVITY_TABLE.length - 1;