// ==========================================================================
//  src/board.js
//  The playfield as a pure 10×20 grid plus the boundary/collision checks.
//  board[y][x] — y is the row (0 = top), x is the column. A cell holds 0
//  (empty) or the identifier of the locked piece that occupies it.
// ==========================================================================

import { BOARD_WIDTH, BOARD_HEIGHT } from './config.js';
import { getAbsoluteCells } from './pieces.js';

// A fresh, empty 10×20 grid.
export function createBoard() {
  return Array.from({ length: BOARD_HEIGHT }, () => Array(BOARD_WIDTH).fill(0));
}

// True if (x, y) is inside the visible field.
export function inBounds(x, y) {
  return x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT;
}

// True if a piece at (piece.x, piece.y) in its current rotation fits:
// no cell past the side walls, no cell below the floor, and no overlap with
// locked cells. Cells in the hidden buffer (y < 0) are always allowed.
export function isValidPosition(piece, board) {
  for (const [x, y] of getAbsoluteCells(piece)) {
    if (x < 0 || x >= BOARD_WIDTH) return false; // side walls
    if (y >= BOARD_HEIGHT) return false;         // floor
    if (y >= 0 && board[y][x]) return false;     // overlap with the stack
  }
  return true;
}