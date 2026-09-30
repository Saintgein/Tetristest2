// ==========================================================================
//  src/renderer.js
//  Canvas drawing (SPEC §6.5): NES-style beveled block sprites, the well,
//  ghost, active piece, and the hold / next previews.
//  Blocks are painted once per color into offscreen sprites; render() only
//  blits them, so the per-frame path does no gradient or per-pixel work.
// ==========================================================================

import {
  BLOCK, PREVIEW_BLOCK, COLS, VISIBLE_ROWS, HIDDEN_ROWS, NEXT_COUNT, PALETTE, COLORS,
} from './config.js';
import { getCells, TYPE_INDEX } from './pieces.js';
import { dropDistance } from './board.js';

const FLASH_PALETTE = { face: COLORS.flash, light: '#ffffff', dark: '#bcbcbc' };
const HOLD_USED_ALPHA = 0.4;
const NEXT_SLOT_HEIGHT = 48;                  // next canvas is 80 × 144 = 3 slots

/** Bevel width for a block size: 2px at 16px, never below 1. */
const bevelFor = (size) => Math.max(1, Math.round(size / 8));

/**
 * Paints one block with the NES look (SPEC §6.5). Used to build sprites; not
 * called per frame.
 *
 *   row/col 0            : `COLORS.outline` seam (top + left)
 *   rows/cols 1..bevel   : `light` highlight (top + left)
 *   last `bevel` rows/cols: `dark` shadow (bottom + right)
 *   corners top-right / bottom-left are split along the diagonal
 *   2×2 `COLORS.sheen` at (bevel+1, bevel+1) for the 16-bit sheen
 *
 * @param {'normal'|'ghost'|'flash'} style
 */
export function drawBlock(ctx, px, py, size, colorIndex, style = 'normal') {
  const bevel = bevelFor(size);

  if (style === 'ghost') {
    ctx.fillStyle = COLORS.ghost;
    ctx.fillRect(px, py, size, bevel);                              // top
    ctx.fillRect(px, py + size - bevel, size, bevel);               // bottom
    ctx.fillRect(px, py + bevel, bevel, size - 2 * bevel);          // left
    ctx.fillRect(px + size - bevel, py + bevel, bevel, size - 2 * bevel); // right
    return;
  }

  const p = style === 'flash' ? FLASH_PALETTE : PALETTE[colorIndex];
  if (!p) return;
  const inner = size - 1;

  ctx.fillStyle = COLORS.outline;
  ctx.fillRect(px, py, size, 1);
  ctx.fillRect(px, py + 1, 1, inner);

  ctx.fillStyle = p.face;
  ctx.fillRect(px + 1, py + 1, inner, inner);

  ctx.fillStyle = p.light;
  ctx.fillRect(px + 1, py + 1, inner, bevel);
  ctx.fillRect(px + 1, py + 1, bevel, inner);

  ctx.fillStyle = p.dark;
  ctx.fillRect(px + 1, py + size - bevel, inner, bevel);
  ctx.fillRect(px + size - bevel, py + 1, bevel, inner);

  // Miter the two mixed corners: pixels above the anti-diagonal stay light.
  ctx.fillStyle = p.light;
  for (let i = 0; i < bevel; i++) {
    for (let j = 0; j < bevel; j++) {
      const trX = size - bevel + i, trY = 1 + j;                    // top-right
      if (trX + trY < size) ctx.fillRect(px + trX, py + trY, 1, 1);
      const blX = 1 + i, blY = size - bevel + j;                    // bottom-left
      if (blX + blY < size) ctx.fillRect(px + blX, py + blY, 1, 1);
    }
  }

  ctx.fillStyle = COLORS.sheen;
  ctx.fillRect(px + bevel + 1, py + bevel + 1, bevel, bevel);
}

function defaultCreateCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Pre-renders every block look once.
 * @returns {Map<number|'ghost'|'flash', HTMLCanvasElement|OffscreenCanvas>}
 *          keys 1–7 = TYPE_INDEX colors, plus 'ghost' and 'flash'
 */
export function buildBlockSprites(size, createCanvas = defaultCreateCanvas) {
  const sprites = new Map();
  const paint = (key, colorIndex, style) => {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    drawBlock(ctx, 0, 0, size, colorIndex, style);
    sprites.set(key, canvas);
  };
  for (const index of Object.keys(PALETTE)) paint(Number(index), Number(index), 'normal');
  paint('ghost', 0, 'ghost');
  paint('flash', 0, 'flash');
  return sprites;
}

/**
 * Top-left pixel at which to draw a piece's bounding box so its filled cells
 * are centered in a `width × height` area (rounded down to whole pixels).
 * @returns {[number, number]}
 */
export function previewOrigin(type, width, height, size) {
  const cells = getCells(type, 0);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < cells.length; i++) {
    const [x, y] = cells[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = (maxX - minX + 1) * size;
  const h = (maxY - minY + 1) * size;
  return [Math.floor((width - w) / 2) - minX * size, Math.floor((height - h) / 2) - minY * size];
}

function context2d(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/**
 * @param {{ boardCanvas, holdCanvas, nextCanvas }} canvases
 * @param {{ createCanvas?: (w: number, h: number) => object }} [options] offscreen canvas factory (tests)
 * @returns {{ render(state: object): void }}
 */
export function createRenderer({ boardCanvas, holdCanvas, nextCanvas }, { createCanvas = defaultCreateCanvas } = {}) {
  const boardCtx = context2d(boardCanvas);
  const holdCtx = context2d(holdCanvas);
  const nextCtx = context2d(nextCanvas);

  const sprites = buildBlockSprites(BLOCK, createCanvas);
  const previewSprites = PREVIEW_BLOCK === BLOCK ? sprites : buildBlockSprites(PREVIEW_BLOCK, createCanvas);

  // Well background (fill + grid dots), painted once.
  const wellWidth = COLS * BLOCK;
  const wellHeight = VISIBLE_ROWS * BLOCK;
  const well = createCanvas(wellWidth, wellHeight);
  const wellCtx = well.getContext('2d');
  wellCtx.fillStyle = COLORS.wellBg;
  wellCtx.fillRect(0, 0, wellWidth, wellHeight);
  wellCtx.fillStyle = COLORS.gridDot;
  for (let y = 1; y < VISIBLE_ROWS; y++) {
    for (let x = 1; x < COLS; x++) wellCtx.fillRect(x * BLOCK, y * BLOCK, 1, 1);
  }

  /** Draws a piece in board coordinates; cells in the hidden rows are clipped. */
  function drawBoardPiece(type, rotation, px, py, sprite) {
    const cells = getCells(type, rotation);
    for (let i = 0; i < cells.length; i++) {
      const y = py + cells[i][1];
      if (y < HIDDEN_ROWS) continue;
      boardCtx.drawImage(sprite, (px + cells[i][0]) * BLOCK, (y - HIDDEN_ROWS) * BLOCK);
    }
  }

  function drawPreview(ctx, type, originX, originY, width, height) {
    const [ox, oy] = previewOrigin(type, width, height, PREVIEW_BLOCK);
    const sprite = previewSprites.get(TYPE_INDEX[type]);
    const cells = getCells(type, 0);
    for (let i = 0; i < cells.length; i++) {
      ctx.drawImage(sprite, originX + ox + cells[i][0] * PREVIEW_BLOCK, originY + oy + cells[i][1] * PREVIEW_BLOCK);
    }
  }

  function renderBoard(state) {
    const { board, active } = state;
    boardCtx.drawImage(well, 0, 0);
    if (state.phase === 'paused') return;         // NES-style: no peeking at the stack while paused

    for (let y = HIDDEN_ROWS; y < board.rows; y++) {
      const row = board.cells[y];
      for (let x = 0; x < board.cols; x++) {
        if (row[x] !== 0) boardCtx.drawImage(sprites.get(row[x]), x * BLOCK, (y - HIDDEN_ROWS) * BLOCK);
      }
    }

    if (!active) return;
    const distance = dropDistance(board, active);
    if (distance > 0) {
      drawBoardPiece(active.type, active.rotation, active.x, active.y + distance, sprites.get('ghost'));
    }
    drawBoardPiece(active.type, active.rotation, active.x, active.y, sprites.get(TYPE_INDEX[active.type]));
  }

  function renderPreviews(state) {
    holdCtx.clearRect(0, 0, holdCanvas.width, holdCanvas.height);
    nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
    // The title screen's bag isn't the one the game will deal from, so don't
    // preview it; while paused, hide the previews along with the stack.
    if (state.phase === 'title' || state.phase === 'paused') return;

    if (state.hold.type !== null) {
      holdCtx.globalAlpha = state.hold.used ? HOLD_USED_ALPHA : 1;
      drawPreview(holdCtx, state.hold.type, 0, 0, holdCanvas.width, holdCanvas.height);
      holdCtx.globalAlpha = 1;
    }

    const count = Math.min(NEXT_COUNT, state.queue.length);
    for (let i = 0; i < count; i++) {
      drawPreview(nextCtx, state.queue[i], 0, i * NEXT_SLOT_HEIGHT, nextCanvas.width, NEXT_SLOT_HEIGHT);
    }
  }

  return {
    render(state) {
      renderBoard(state);
      renderPreviews(state);
    },
  };
}
