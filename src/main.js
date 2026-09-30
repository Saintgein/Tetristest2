// ==========================================================================
//  src/main.js
//  Bootstrap: integer pixel scaling + wiring the game modules together.
//  QA aid: ?level=N (0–99) sets the start level until the M4 level menu.
// ==========================================================================

import { MAX_LEVEL } from './config.js';
import { createInput } from './input.js';
import { createRenderer } from './renderer.js';
import { createUI } from './ui.js';
import { createGame, createInitialState } from './game.js';

const MAX_SCALE = 6;

const $ = (id) => document.getElementById(id);
const cabinet = $('cabinet');
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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const startLevel = clamp(
  parseInt(new URLSearchParams(location.search).get('level'), 10) || 0, 0, MAX_LEVEL);

const game = createGame({
  input: createInput(window),
  renderer: createRenderer({
    boardCanvas: $('board-canvas'),
    holdCanvas: $('hold-canvas'),
    nextCanvas: $('next-canvas'),
  }),
  ui: createUI({
    score: $('hud-score'),
    hiScore: $('hud-hiscore'),
    level: $('hud-level'),
    lines: $('hud-lines'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlaySub: $('overlay-sub'),
  }),
  audio: { play() {} },                        // M5
  initialState: createInitialState({ startLevel }),
});

game.start();

// Auto-pause when the player leaves: tab hidden, window minimized or unfocused.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.pause();
});
window.addEventListener('blur', () => game.pause());

fitScale();
window.addEventListener('resize', fitScale);
// Web font metrics change the cabinet size once loaded
document.fonts?.ready.then(fitScale);
