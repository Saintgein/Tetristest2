// Milestone 2 debug bootstrap.
// Fits the cabinet to the viewport at an integer pixel scale and renders a
// static scene (empty well + one I and one T piece) to verify the renderer.
// The real game loop replaces this wiring in a later milestone.

import { COLS, ROWS } from './config.js';
import { createBoard } from './board.js';
import { spawnPiece } from './pieces.js';
import { drawBoard, drawPiece } from './renderer.js';

const MAX_SCALE = 6;

const cabinet = document.getElementById('cabinet');
const root = document.documentElement;

function getScale() {
  return Number(getComputedStyle(root).getPropertyValue('--scale')) || 1;
}

// Measure the cabinet at the current scale, derive its logical size, then pick
// the largest integer scale that fits the viewport.
function fitScale() {
  const current = getScale();
  const rect = cabinet.getBoundingClientRect();
  const logicalW = rect.width / current;
  const logicalH = rect.height / current;
  const scale = Math.max(1, Math.min(
    MAX_SCALE,
    Math.floor(Math.min(window.innerWidth / logicalW, window.innerHeight / logicalH)),
  ));
  if (scale !== current) root.style.setProperty('--scale', String(scale));
}

function getContext(id) {
  const ctx = document.getElementById(id).getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

// --- Static debug scene ----------------------------------------------------
const boardCtx = getContext('board-canvas');
getContext('hold-canvas');
getContext('next-canvas');

const board = createBoard(COLS, ROWS); // 10 × 22, 2 hidden rows

// Spawn both pieces, then nudge them into the visible well so the debug
// scene is actually on screen (spawn rows 0–1 are hidden).
const iPiece = spawnPiece('I');
iPiece.y = 5;
const tPiece = spawnPiece('T');
tPiece.y = 10;

drawBoard(boardCtx, board);
drawPiece(boardCtx, iPiece);
drawPiece(boardCtx, tPiece);
// ---------------------------------------------------------------------------

fitScale();
window.addEventListener('resize', fitScale);
// Web font metrics change the cabinet size once loaded
document.fonts?.ready.then(fitScale);
