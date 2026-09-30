// ==========================================================================
//  src/config.js
//  All tunable constants (SPEC §5). Frame counts assume 60 fps.
// ==========================================================================

// Grid: 10 × 22 — rows 0–1 are hidden spawn rows, rows 2–21 are visible (SPEC §4).
export const COLS = 10;
export const VISIBLE_ROWS = 20;
export const HIDDEN_ROWS = 2;
export const ROWS = VISIBLE_ROWS + HIDDEN_ROWS;   // 22
export const BLOCK = 16;                          // logical px per cell
export const PREVIEW_BLOCK = 16;

export const FPS = 60;
export const STEP_MS = 1000 / FPS;
export const MAX_FRAME_MS = 250;                  // clamp after tab-switch stalls

export const DAS_FRAMES = 10;                     // ~167 ms before auto-repeat
export const ARR_FRAMES = 2;                      // ~33 ms between repeats (0 = instant to wall)
export const SOFT_DROP_G = 0.5;                   // rows/frame while soft-dropping (min)
export const LOCK_DELAY_FRAMES = 30;              // base lock delay (see progression)
export const MAX_LOCK_RESETS = 15;                // move-reset cap per piece
export const LINE_CLEAR_FRAMES = 20;              // clear animation length
export const ARE_FRAMES = 6;                      // entry delay after lock
export const NEXT_COUNT = 3;                      // previews shown
export const MAX_LEVEL = 99;
export const MAX_START_LEVEL = 19;
export const SCORE_MILESTONE = 10_000;            // see SPEC §8.2

// KeyboardEvent.code values (layout-independent physical keys).
export const KEY_BINDINGS = {
  left:      ['ArrowLeft', 'KeyA'],
  right:     ['ArrowRight', 'KeyD'],
  softDrop:  ['ArrowDown', 'KeyS'],
  hardDrop:  ['Space'],
  rotateCW:  ['ArrowUp', 'KeyX', 'KeyW'],
  rotateCCW: ['KeyZ'],                    // no Ctrl: Ctrl+W (rotate CW) would close the tab
  hold:      ['KeyC', 'ShiftLeft', 'ShiftRight'],
  pause:     ['KeyP', 'Escape'],
  start:     ['Enter'],
  mute:      ['KeyM'],
};

// Per piece type index 1–7: face, highlight (top/left bevel), shadow (bottom/right bevel).
export const PALETTE = {
  1: { face: '#3cbcfc', light: '#a4e4fc', dark: '#0078b8' }, // I cyan
  2: { face: '#0058f8', light: '#6888fc', dark: '#0000a8' }, // J blue
  3: { face: '#f87800', light: '#fcb868', dark: '#a84000' }, // L orange
  4: { face: '#f8b800', light: '#fce0a8', dark: '#ac7c00' }, // O yellow
  5: { face: '#00b800', light: '#b8f818', dark: '#006800' }, // S green
  6: { face: '#b800b8', light: '#f878f8', dark: '#680068' }, // T purple
  7: { face: '#e40058', light: '#f87898', dark: '#a80020' }, // Z red
};

export const COLORS = {
  wellBg: '#000000',
  gridDot: '#1a1a2e',
  ghost: 'rgba(255,255,255,0.35)',
  flash: '#fcfcfc',
  outline: 'rgba(0,0,0,0.5)',   // 1px top/left block seam
  sheen: '#fcfcfc',             // 2×2 highlight pixel
};
