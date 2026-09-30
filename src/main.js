// Milestone 0 placeholder bootstrap.
// Fits the cabinet to the viewport at an integer pixel scale and draws an
// empty well so the layout can be checked. Milestone 1 moves the constants
// into config.js and Milestone 2 replaces this with the real game wiring
// (see TASKS.md).

const BLOCK = 16;
const COLS = 10;
const VISIBLE_ROWS = 20;
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

function drawEmptyWell(ctx) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, COLS * BLOCK, VISIBLE_ROWS * BLOCK);
  // One dot at each cell corner — classic subtle grid
  ctx.fillStyle = '#1a1a2e';
  for (let y = 1; y < VISIBLE_ROWS; y++) {
    for (let x = 1; x < COLS; x++) {
      ctx.fillRect(x * BLOCK, y * BLOCK, 1, 1);
    }
  }
}

drawEmptyWell(getContext('board-canvas'));
getContext('hold-canvas');
getContext('next-canvas');

fitScale();
window.addEventListener('resize', fitScale);
// Web font metrics change the cabinet size once loaded
document.fonts?.ready.then(fitScale);
