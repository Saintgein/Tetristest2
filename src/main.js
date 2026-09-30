// ==========================================================================
//  src/main.js
//  Bootstrap: integer pixel scaling + wiring the game modules together.
//  QA aids: ?level=N (0–99, beyond the menu's 0–19) sets the start level;
//  ?reducedMotion forces reduced motion; ?debug exposes window.__game and
//  window.__audio for scripted browser tests.
// ==========================================================================

import { MAX_LEVEL } from './config.js';
import { createInput } from './input.js';
import { createRenderer } from './renderer.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { createGame, createInitialState, loadStartLevel } from './game.js';

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

  // If viewport is smaller than minimum scale 1 (e.g. 320px screen), scale down cleanly
  const fitFactor = Math.min(1, window.innerWidth / (logicalW * scale), window.innerHeight / (logicalH * scale));
  cabinet.style.transform = fitFactor < 1 ? `scale(${fitFactor})` : '';
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const params = new URLSearchParams(location.search);

let storage = null;
try { storage = window.localStorage; } catch { /* blocked: play without persistence */ }

// Start level: ?level wins, else the last level chosen on the title screen
const startLevel = params.has('level')
  ? clamp(parseInt(params.get('level'), 10) || 0, 0, MAX_LEVEL)
  : loadStartLevel(storage);

// Reduced motion: OS/browser setting (live), or forced with ?reducedMotion
const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
const reducedMotion = () => params.has('reducedMotion') || Boolean(motionQuery?.matches);
const applyMotionClass = () => root.classList.toggle('reduced-motion', reducedMotion());
applyMotionClass();
motionQuery?.addEventListener?.('change', applyMotionClass);

// Touch device detection: coarse pointer, maxTouchPoints, ontouchstart, or forced with ?touch
const hasTouch = () =>
  params.has('touch') ||
  Boolean(window.matchMedia?.('(pointer: coarse)')?.matches) ||
  ('ontouchstart' in window) ||
  (Number(navigator.maxTouchPoints) > 0);

if (hasTouch()) {
  root.classList.add('has-touch');
}
window.addEventListener('touchstart', () => root.classList.add('has-touch'), { once: true, passive: true });

// Suppress long-press context menus on touch areas
window.addEventListener('contextmenu', (e) => {
  if (e.target?.closest?.('.cabinet, .touch-controls, .touch-btn, .well, .pixel-canvas')) {
    e.preventDefault();
  }
}, { capture: true, passive: false });

const audio = createAudio();
// Browsers only start audio from a user gesture; unlock() is cheap, idempotent and never
// throws (a blocked AudioContext just means silence). Listening on touchstart, touchend,
// pointerdown, keydown, and gamepad button presses ensures reliable unlock across all devices.
const unlockAudio = () => audio.unlock();
window.addEventListener('keydown', unlockAudio, { capture: true });
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('mousedown', unlockAudio, { capture: true });
window.addEventListener('click', unlockAudio, { capture: true });
window.addEventListener('touchstart', unlockAudio, { capture: true, passive: true });
window.addEventListener('touchend', unlockAudio, { capture: true, passive: true });

// Gamepad detection and connection lifecycle
let connectedGamepads = 0;
function countGamepads() {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return 0;
  try {
    const list = navigator.getGamepads();
    if (!list) return 0;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].connected !== false) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

const hasGamepad = () => connectedGamepads > 0 || countGamepads() > 0;

window.addEventListener('gamepadconnected', () => {
  connectedGamepads++;
  root.classList.add('has-gamepad');
  unlockAudio();
});

window.addEventListener('gamepaddisconnected', () => {
  connectedGamepads = Math.max(0, connectedGamepads - 1);
  if (!hasGamepad()) {
    root.classList.remove('has-gamepad');
  }
});

if (hasGamepad()) {
  root.classList.add('has-gamepad');
}

const input = createInput(window, undefined, undefined, {
  touchRoot: $('touch-controls'),
  onGamepadButton: unlockAudio,
  onUserGesture: unlockAudio,
});

const game = createGame({
  input,
  renderer: createRenderer({
    boardCanvas: $('board-canvas'),
    holdCanvas: $('hold-canvas'),
    nextCanvas: $('next-canvas'),
  }, { reducedMotion }),
  ui: createUI({
    score: $('hud-score'),
    hiScore: $('hud-hiscore'),
    level: $('hud-level'),
    lines: $('hud-lines'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlaySub: $('overlay-sub'),
    overlayInfo: $('overlay-info'),
    well: $('well'),
    sound: $('hud-sound'),
    music: $('hud-music'),
  }, { reducedMotion, hasGamepad }),
  audio,
  storage,
  initialState: createInitialState({ startLevel }),
});

// Title screen start via touch controls (PAUSE or A starts the game)
$('touch-controls')?.addEventListener?.('pointerdown', (e) => {
  unlockAudio();
  const action = e.target?.closest?.('[data-action]')?.getAttribute('data-action');
  if ((action === 'pause' || action === 'rotateCW') && game.getState().phase === 'title') {
    input.press('start');
  }
}, { capture: true });

game.start();

// Footer toggles (same as M / B). pointerdown is cancelled so the buttons never take
// focus: Space and Enter must keep driving the game, not re-click a focused button.
for (const [id, toggle] of [['hud-sound', () => game.toggleMute()], ['hud-music', () => game.toggleMusic()]]) {
  const button = $(id);
  button.addEventListener('pointerdown', (e) => e.preventDefault());
  button.addEventListener('click', toggle);
}

// QA aid: ?debug exposes the game and audio for scripted browser tests.
if (params.has('debug')) Object.assign(window, { __game: game, __audio: audio, __input: input });

// Auto-pause when the player leaves: tab hidden, window minimized or unfocused.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.pause();
});
window.addEventListener('blur', () => game.pause());

fitScale();
window.addEventListener('resize', fitScale);
window.addEventListener('orientationchange', fitScale);
// Web font metrics change the cabinet size once loaded
document.fonts?.ready.then(fitScale);
