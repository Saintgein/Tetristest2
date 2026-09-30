// ==========================================================================
//  src/renderer.js
//  Canvas drawing for the playfield: NES-style beveled blocks, the dotted
//  grid background, the settled board and the active piece.
//  All functions take a 2D context and draw in logical pixels (BLOCK size).
// ==========================================================================

import { BLOCK, HIDDEN_ROWS, PALETTE, COLORS } from './config.js';
import { getAbsoluteCells, TYPE_INDEX } from './pieces.js';

/**
 * Draws one beveled block at pixel coordinates (x, y).
 * Top/left 2px borders use the light shade, bottom/right 2px the dark shade,
 * and the inner area the face color — the classic NES tetromino look.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x left edge in px
 * @param {number} y top edge in px
 * @param {number} typeId 1–7 (TYPE_INDEX)
 * @param {Record<number, {face: string, light: string, dark: string}>} [palette]
 */
export function drawBlock(ctx, x, y, typeId, palette = PALETTE) {
  const p = palette[typeId];
  if (!p) return;

  // Face first, then the bevel borders on top.
  ctx.fillStyle = p.face;
  ctx.fillRect(x, y, BLOCK, BLOCK);

  ctx.fillStyle = p.light;
  ctx.fillRect(x, y, BLOCK, 2);          // top
  ctx.fillRect(x, y, 2, BLOCK);          // left

  ctx.fillStyle = p.dark;
  ctx.fillRect(x, y + BLOCK - 2, BLOCK, 2); // bottom
  ctx.fillRect(x + BLOCK - 2, y, 2, BLOCK); // right
}

/**
 * Fills the playfield background and marks each interior grid intersection
 * with a single subtle dot.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cols
 * @param {number} rows
 * @param {number} blockSize px per cell
 */
export function drawGrid(ctx, cols, rows, blockSize) {
  ctx.fillStyle = COLORS.wellBg;
  ctx.fillRect(0, 0, cols * blockSize, rows * blockSize);

  ctx.fillStyle = COLORS.gridDot;
  for (let y = 1; y < rows; y++) {
    for (let x = 1; x < cols; x++) {
      ctx.fillRect(x * blockSize, y * blockSize, 1, 1);
    }
  }
}

/**
 * Clears the canvas, draws the background grid and renders every settled
 * cell. Hidden rows (y < HIDDEN_ROWS) are never drawn.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{cols: number, rows: number, cells: Uint8Array[]}} board
 */
export function drawBoard(ctx, board) {
  const visibleRows = board.rows - HIDDEN_ROWS;
  ctx.clearRect(0, 0, board.cols * BLOCK, visibleRows * BLOCK);
  drawGrid(ctx, board.cols, visibleRows, BLOCK);

  for (let y = HIDDEN_ROWS; y < board.rows; y++) {
    const row = board.cells[y];
    for (let x = 0; x < board.cols; x++) {
      const typeId = row[x];
      if (typeId !== 0) {
        drawBlock(ctx, x * BLOCK, (y - HIDDEN_ROWS) * BLOCK, typeId);
      }
    }
  }
}

/**
 * Renders the active piece at its current board position. Cells that sit in
 * the hidden spawn rows are skipped (they are above the visible well).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{type: string, rotation: number, x: number, y: number}} piece
 */
export function drawPiece(ctx, piece) {
  const typeId = TYPE_INDEX[piece.type];
  for (const [x, y] of getAbsoluteCells(piece)) {
    if (y < HIDDEN_ROWS) continue;
    drawBlock(ctx, x * BLOCK, (y - HIDDEN_ROWS) * BLOCK, typeId);
  }
}
/**
 * Per-frame renderer used by the game loop (SPEC §6.5). M2 draws the well and
 * the active piece; hold/next previews and the ghost arrive in M3.
 * @param {{ boardCanvas: HTMLCanvasElement, holdCanvas: HTMLCanvasElement, nextCanvas: HTMLCanvasElement }} canvases
 * @returns {{ render(state: object): void }}
 */
export function createRenderer({ boardCanvas }) {
  const ctx = boardCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  return {
    render(state) {
      drawBoard(ctx, state.board);
      if (state.active) drawPiece(ctx, state.active);
    },
  };
}
