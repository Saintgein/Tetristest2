// ==========================================================================
//  src/board.js
//  Playfield grid, collision, locking and line clearing (SPEC §6.2).
//  cells[y][x]: y = 0 is the top hidden row, y = ROWS - 1 the floor row.
//  Value 0 = empty, 1–7 = TYPE_INDEX of the locked piece. Pure, no DOM.
// ==========================================================================

import { COLS, ROWS, HIDDEN_ROWS } from './config.js';
import { getAbsoluteCells, getCells, TYPE_INDEX } from './pieces.js';

/** @typedef {import('./pieces.js').Piece} Piece */
/** @typedef {{ cols: number, rows: number, cells: Uint8Array[] }} Board */

/** @returns {Board} */
export function createBoard(cols = COLS, rows = ROWS) {
  return {
    cols,
    rows,
    cells: Array.from({ length: rows }, () => new Uint8Array(cols)),
  };
}

/** True if (x, y) lies inside the grid, hidden rows included. */
export function inBounds(board, x, y) {
  return x >= 0 && x < board.cols && y >= 0 && y < board.rows;
}

/**
 * True if every cell of the piece is in bounds and empty. y < 0 is invalid.
 * Runs several times per frame, so it reads the cached shape instead of allocating.
 */
export function isValidPosition(board, piece) {
  const shape = getCells(piece.type, piece.rotation);
  for (let i = 0; i < shape.length; i++) {
    const x = piece.x + shape[i][0];
    const y = piece.y + shape[i][1];
    if (!inBounds(board, x, y) || board.cells[y][x] !== 0) return false;
  }
  return true;
}

/** Writes the piece into the grid (mutates). Assumes a valid position. */
export function lockPiece(board, piece) {
  const value = TYPE_INDEX[piece.type];
  for (const [x, y] of getAbsoluteCells(piece)) {
    board.cells[y][x] = value;
  }
}

/** @returns {number[]} indices of completely filled rows, ascending. */
export function findFullRows(board) {
  const rows = [];
  for (let y = 0; y < board.rows; y++) {
    if (board.cells[y].every((v) => v !== 0)) rows.push(y);
  }
  return rows;
}

/**
 * Removes the given rows (any order, need not be contiguous), shifts
 * everything above them down and inserts empty rows at the top.
 * @returns {number} number of rows removed
 */
export function clearRows(board, rows) {
  const remove = new Set(rows);
  const kept = board.cells.filter((_, y) => !remove.has(y));
  const removed = board.rows - kept.length;
  const fresh = Array.from({ length: removed }, () => new Uint8Array(board.cols));
  board.cells = fresh.concat(kept);
  return removed;
}

/** True if every cell of the piece is in the hidden rows (SPEC §8.4 lock out). */
export function isLockOut(piece) {
  return getAbsoluteCells(piece).every(([, y]) => y < HIDDEN_ROWS);
}

/**
 * Rows the piece can fall before colliding (ghost / hard drop).
 * Called by the renderer every frame, so it doesn't allocate or touch `piece`.
 * @returns {number}
 */
export function dropDistance(board, piece) {
  const shape = getCells(piece.type, piece.rotation);
  for (let distance = 0; ; distance++) {
    const top = piece.y + distance + 1;
    for (let i = 0; i < shape.length; i++) {
      const x = piece.x + shape[i][0];
      const y = top + shape[i][1];
      if (!inBounds(board, x, y) || board.cells[y][x] !== 0) return distance;
    }
  }
}
