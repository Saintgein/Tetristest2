import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawBlock, buildBlockSprites, previewOrigin, createRenderer, lineClearFrame } from '../src/renderer.js';
import { createBoard } from '../src/board.js';
import { PIECE_TYPES, TYPE_INDEX } from '../src/pieces.js';
import { PALETTE, COLORS, BLOCK, LINE_CLEAR_FRAMES } from '../src/config.js';
import { createFakeCanvas, hex } from './helpers/fake-canvas.js';

const rgb = (px) => px.slice(0, 3);
const T = PALETTE[TYPE_INDEX.T];

function setup() {
  const created = [];
  const createCanvas = (w, h) => { const c = createFakeCanvas(w, h); created.push(c); return c; };
  const log = [];
  const canvases = {
    boardCanvas: createFakeCanvas(160, 320, log),
    holdCanvas: createFakeCanvas(80, 48),
    nextCanvas: createFakeCanvas(80, 144),
  };
  const renderer = createRenderer(canvases, { createCanvas });
  return { ...canvases, renderer, created, log };
}

const playState = (over = {}) => ({
  phase: 'playing',
  board: createBoard(),
  active: null,
  hold: { type: null, used: false },
  queue: ['I', 'O', 'T'],
  ...over,
});

/** Canvas pixel at the center of board cell (x, y), y in board rows (hidden rows included). */
const cellCenter = (canvas, x, y) => canvas.pixel(x * BLOCK + 8, (y - 2) * BLOCK + 8);

// ---------- sprites ----------

test('drawBlock: NES outline, bevel, mitered corners and sheen pixel (16px)', () => {
  const c = createFakeCanvas(16, 16);
  drawBlock(c.getContext(), 0, 0, 16, TYPE_INDEX.T);
  const at = (x, y) => rgb(c.pixel(x, y));

  // Top/left seam: 50% black
  for (const [x, y] of [[0, 0], [8, 0], [15, 0], [0, 8], [0, 15]]) {
    assert.deepEqual(c.pixel(x, y), [0, 0, 0, 0.5], `outline ${x},${y}`);
  }
  // Light band rows/cols 1–2, dark band rows/cols 14–15
  for (const [x, y] of [[1, 1], [8, 1], [8, 2], [1, 8], [2, 8]]) assert.deepEqual(at(x, y), hex(T.light), `light ${x},${y}`);
  for (const [x, y] of [[8, 14], [8, 15], [14, 8], [15, 8], [15, 15], [14, 14]]) assert.deepEqual(at(x, y), hex(T.dark), `dark ${x},${y}`);
  // Mitered corners along the anti-diagonal
  assert.deepEqual(at(14, 1), hex(T.light));
  assert.deepEqual(at(15, 1), hex(T.dark));
  assert.deepEqual(at(14, 2), hex(T.dark));
  assert.deepEqual(at(1, 14), hex(T.light));
  assert.deepEqual(at(2, 14), hex(T.dark));
  assert.deepEqual(at(1, 15), hex(T.dark));
  // 2×2 sheen at (3,3); face everywhere else inside
  for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) assert.deepEqual(at(x, y), hex(COLORS.sheen), `sheen ${x},${y}`);
  for (const [x, y] of [[5, 5], [8, 8], [13, 13], [3, 5], [5, 3]]) assert.deepEqual(at(x, y), hex(T.face), `face ${x},${y}`);
  // Opaque everywhere except the seam
  for (let y = 1; y < 16; y++) for (let x = 1; x < 16; x++) assert.equal(c.pixel(x, y)[3], 1);
});

test('drawBlock: draws at an offset without touching pixels outside the cell', () => {
  const c = createFakeCanvas(40, 40);
  drawBlock(c.getContext(), 12, 20, 16, TYPE_INDEX.I);
  assert.deepEqual(c.bounds(), [12, 20, 27, 35]);
});

test('drawBlock: ghost style is a 2px translucent outline with an empty middle', () => {
  const c = createFakeCanvas(16, 16);
  drawBlock(c.getContext(), 0, 0, 16, 0, 'ghost');
  for (const [x, y] of [[0, 0], [8, 1], [15, 15], [1, 8], [14, 8]]) assert.deepEqual(c.pixel(x, y), [255, 255, 255, 0.35], `${x},${y}`);
  for (const [x, y] of [[2, 2], [8, 8], [13, 13]]) assert.equal(c.pixel(x, y)[3], 0, `${x},${y}`);
});

test('drawBlock: flash style is a white bevel block; unknown colors draw nothing', () => {
  const c = createFakeCanvas(16, 16);
  drawBlock(c.getContext(), 0, 0, 16, 0, 'flash');
  assert.deepEqual(rgb(c.pixel(8, 8)), hex(COLORS.flash));
  const empty = createFakeCanvas(16, 16);
  drawBlock(empty.getContext(), 0, 0, 16, 42);
  assert.equal(empty.bounds(), null);
});

test('drawBlock: scales bevel and sheen with size', () => {
  const small = createFakeCanvas(8, 8);
  drawBlock(small.getContext(), 0, 0, 8, TYPE_INDEX.O);     // bevel 1
  const O = PALETTE[TYPE_INDEX.O];
  assert.deepEqual(rgb(small.pixel(1, 1)), hex(O.light));
  assert.deepEqual(rgb(small.pixel(7, 7)), hex(O.dark));
  assert.deepEqual(rgb(small.pixel(2, 2)), hex(COLORS.sheen));
  assert.deepEqual(rgb(small.pixel(4, 4)), hex(O.face));
});

test('buildBlockSprites: one sprite per color plus ghost and flash, each painted like drawBlock', () => {
  const sprites = buildBlockSprites(16, (w, h) => createFakeCanvas(w, h));
  assert.deepEqual([...sprites.keys()], [1, 2, 3, 4, 5, 6, 7, 'ghost', 'flash']);
  for (const type of PIECE_TYPES) {
    const sprite = sprites.get(TYPE_INDEX[type]);
    assert.equal(sprite.width, 16);
    assert.deepEqual(rgb(sprite.pixel(8, 8)), hex(PALETTE[TYPE_INDEX[type]].face), type);
  }
  assert.equal(sprites.get('ghost').pixel(8, 8)[3], 0);
});

// ---------- board ----------

test('render: well background with grid dots at interior cell corners', () => {
  const { boardCanvas, renderer } = setup();
  renderer.render(playState());
  assert.deepEqual(boardCanvas.pixel(8, 8), [0, 0, 0, 1]);
  assert.deepEqual(rgb(boardCanvas.pixel(16, 16)), hex(COLORS.gridDot));
  assert.deepEqual(rgb(boardCanvas.pixel(144, 304)), hex(COLORS.gridDot));
  assert.deepEqual(boardCanvas.pixel(0, 0), [0, 0, 0, 1], 'no dot on the edge');
});

test('render: locked cells in visible rows use their piece color; hidden rows are not drawn', () => {
  const { boardCanvas, renderer, log } = setup();
  const state = playState();
  state.board.cells[21][2] = TYPE_INDEX.L;
  state.board.cells[2][9] = TYPE_INDEX.Z;
  state.board.cells[1][5] = TYPE_INDEX.T;     // hidden
  renderer.render(state);
  assert.deepEqual(rgb(cellCenter(boardCanvas, 2, 21)), hex(PALETTE[TYPE_INDEX.L].face));
  assert.deepEqual(rgb(cellCenter(boardCanvas, 9, 2)), hex(PALETTE[TYPE_INDEX.Z].face));
  const blocks = log.filter(([op, x, y]) => op === 'drawImage' && !(x === 0 && y === 0));
  assert.equal(blocks.length, 2);
});

test('render: active piece drawn; cells in the hidden rows are clipped', () => {
  const { boardCanvas, renderer, log } = setup();
  renderer.render(playState({ active: { type: 'T', rotation: 0, x: 3, y: 1 } }));
  // T at y=1: nub (4,1) is hidden, the bar (3–5, 2) is the top visible row
  for (const x of [3, 4, 5]) assert.deepEqual(rgb(cellCenter(boardCanvas, x, 2)), hex(T.face), `x ${x}`);
  assert.ok(log.every(([op, , y]) => op !== 'drawImage' || y >= 0), 'nothing drawn above the well');
});

test('render: ghost outline at y + dropDistance, behind the active piece', () => {
  const { boardCanvas, renderer } = setup();
  const state = playState({ active: { type: 'T', rotation: 0, x: 3, y: 10 } });
  state.board.cells[21][4] = TYPE_INDEX.I;    // bump under the middle: the bar lands on row 20
  renderer.render(state);
  // dropDistance = 9 → ghost nub (4,19), bar (3–5,20) → canvas rows 17 and 18
  const gray = Math.round(255 * 0.35);
  assert.deepEqual(boardCanvas.pixel(4 * 16 + 2, 17 * 16 + 1), [gray, gray, gray, 1], 'ghost border, nub (4,19)');
  assert.deepEqual(boardCanvas.pixel(3 * 16 + 1, 18 * 16 + 8), [gray, gray, gray, 1], 'ghost border, bar (3,20)');
  assert.deepEqual(rgb(cellCenter(boardCanvas, 4, 19)), [0, 0, 0], 'ghost has no fill');
  assert.deepEqual(rgb(cellCenter(boardCanvas, 4, 18)), [0, 0, 0], 'nothing drawn one row higher');
  assert.deepEqual(rgb(cellCenter(boardCanvas, 4, 10)), hex(T.face), 'active piece still drawn');
});

test('render: no ghost when the piece is already resting', () => {
  const { boardCanvas, renderer, log } = setup();
  renderer.render(playState({ active: { type: 'T', rotation: 0, x: 3, y: 20 } }));
  assert.deepEqual(rgb(cellCenter(boardCanvas, 4, 20)), hex(T.face));
  assert.equal(log.filter(([op]) => op === 'drawImage').length, 1 + 4, 'well + 4 active cells only');
});

test('render: no active piece (ARE / game over) → no piece and no ghost', () => {
  const { renderer, log } = setup();
  renderer.render(playState({ phase: 'are' }));
  assert.equal(log.filter(([op]) => op === 'drawImage').length, 1);
});

test('render: redrawing replaces the previous frame', () => {
  const { boardCanvas, renderer } = setup();
  renderer.render(playState({ active: { type: 'T', rotation: 0, x: 3, y: 10 } }));
  renderer.render(playState({ active: { type: 'T', rotation: 0, x: 3, y: 12 } }));
  assert.deepEqual(boardCanvas.pixel(4 * 16 + 8, 8 * 16 + 8), [0, 0, 0, 1], 'old position cleared');
});

// ---------- previews ----------

test('previewOrigin centers each piece in the hold box (80 × 48)', () => {
  assert.deepEqual(previewOrigin('T', 80, 48, 16), [16, 8]);
  assert.deepEqual(previewOrigin('O', 80, 48, 16), [8, 8]);    // box col 0 is empty
  assert.deepEqual(previewOrigin('I', 80, 48, 16), [8, 0]);    // box row 0 is empty
});

test('hold: piece drawn centered at full opacity', () => {
  const expected = { T: [16, 8, 63, 39], O: [24, 8, 55, 39], I: [8, 16, 71, 31], S: [16, 8, 63, 39] };
  for (const [type, box] of Object.entries(expected)) {
    const { holdCanvas, renderer } = setup();
    renderer.render(playState({ hold: { type, used: false } }));
    assert.deepEqual(holdCanvas.bounds(), box, type);
  }
  const { holdCanvas, renderer } = setup();
  renderer.render(playState({ hold: { type: 'T', used: false } }));
  assert.deepEqual(holdCanvas.pixel(40, 32), [...hex(T.face), 1]);
});

test('hold: dimmed to 40% while hold.used is true', () => {
  const { holdCanvas, renderer } = setup();
  renderer.render(playState({ hold: { type: 'T', used: true } }));
  assert.deepEqual(holdCanvas.pixel(40, 32), [...hex(T.face), 0.4]);
  renderer.render(playState({ hold: { type: 'T', used: false } }));
  assert.equal(holdCanvas.pixel(40, 32)[3], 1, 'restored once hold is available again');
});

test('hold: empty hold draws nothing and clears a previous piece', () => {
  const { holdCanvas, renderer } = setup();
  renderer.render(playState({ hold: { type: 'Z', used: false } }));
  assert.ok(holdCanvas.bounds());
  renderer.render(playState());
  assert.equal(holdCanvas.bounds(), null);
});

test('next: three pieces top to bottom, each centered in its 48px slot', () => {
  const { nextCanvas, renderer } = setup();
  renderer.render(playState({ queue: ['I', 'O', 'T'] }));
  assert.deepEqual(nextCanvas.bounds(0, 0, 80, 48), [8, 16, 71, 31]);
  assert.deepEqual(nextCanvas.bounds(0, 48, 80, 48), [24, 56, 55, 87]);
  assert.deepEqual(nextCanvas.bounds(0, 96, 80, 48), [16, 104, 63, 135]);
  // Sample inside a block (x = 40 would sit on a 1px seam between cells)
  assert.deepEqual(rgb(nextCanvas.pixel(46, 24)), hex(PALETTE[TYPE_INDEX.I].face));
  assert.deepEqual(rgb(nextCanvas.pixel(46, 64)), hex(PALETTE[TYPE_INDEX.O].face));   // O rows start at y 56, 72
  assert.deepEqual(rgb(nextCanvas.pixel(40, 128)), hex(T.face));   // T cells start at x 16, 32, 48
});

test('next: updates as the queue advances', () => {
  const { nextCanvas, renderer } = setup();
  renderer.render(playState({ queue: ['I', 'O', 'T'] }));
  renderer.render(playState({ queue: ['O', 'T', 'S'] }));
  assert.deepEqual(nextCanvas.bounds(0, 0, 80, 48), [24, 8, 55, 39]);
  assert.deepEqual(rgb(nextCanvas.pixel(46, 32)), hex(PALETTE[TYPE_INDEX.O].face));
});

test('previews are blank on the title screen', () => {
  const { holdCanvas, nextCanvas, renderer } = setup();
  renderer.render(playState({ phase: 'title', hold: { type: 'T', used: false } }));
  assert.equal(holdCanvas.bounds(), null);
  assert.equal(nextCanvas.bounds(), null);
});

// ---------- caching ----------

test('sprites and well are built once; render never creates canvases', () => {
  const { renderer, created } = setup();
  assert.equal(created.length, 9 + 1, '7 colors + ghost + flash + well background');
  const state = playState({ active: { type: 'J', rotation: 1, x: 4, y: 6 }, hold: { type: 'T', used: true } });
  for (let i = 0; i < 50; i++) renderer.render(state);
  assert.equal(created.length, 10);
});

test('every blit lands on whole pixels', () => {
  const { renderer } = setup();          // fake drawImage throws on fractional coordinates
  for (const type of PIECE_TYPES) {
    for (let r = 0; r < 4; r++) {
      renderer.render(playState({ active: { type, rotation: r, x: 3, y: 5 }, hold: { type, used: false }, queue: [type, type, type] }));
    }
  }
});

test('paused: board shows only the empty well; previews are hidden', () => {
  const { boardCanvas, holdCanvas, nextCanvas, renderer, log } = setup();
  const state = playState({ phase: 'paused', active: { type: 'T', rotation: 0, x: 3, y: 10 }, hold: { type: 'I', used: false } });
  state.board.cells[21].fill(TYPE_INDEX.O);
  renderer.render(state);
  assert.equal(log.filter(([op]) => op === 'drawImage').length, 1, 'well background only');
  assert.deepEqual(rgb(cellCenter(boardCanvas, 4, 21)), [0, 0, 0]);
  assert.equal(holdCanvas.bounds(), null);
  assert.equal(nextCanvas.bounds(), null);
  state.phase = 'playing';
  renderer.render(state);
  assert.deepEqual(rgb(cellCenter(boardCanvas, 4, 21)), hex(PALETTE[TYPE_INDEX.O].face), 'back on resume');
  assert.ok(holdCanvas.bounds());
});

// ---------- line-clear animation ----------

test('lineClearFrame: 4-frame beats; one more column pair erased per beat; white on even beats', () => {
  const beats = [];
  for (let timer = 0; timer < LINE_CLEAR_FRAMES; timer++) {
    const { erased, flash } = lineClearFrame(timer);
    beats.push(`${erased}${flash ? 'W' : 'c'}`);
  }
  assert.deepEqual(beats, [
    '0W', '0W', '0W', '0W',
    '1c', '1c', '1c', '1c',
    '2W', '2W', '2W', '2W',
    '3c', '3c', '3c', '3c',
    '4W', '4W', '4W', '4W',
  ]);
  assert.equal(lineClearFrame(LINE_CLEAR_FRAMES).erased, 5, 'fully wiped at the end');
});

function clearingState(timer, rows = [21]) {
  const state = playState({ phase: 'lineClear', clearing: { rows, timer } });
  for (const y of rows) state.board.cells[y].fill(TYPE_INDEX.L);
  state.board.cells[20][0] = TYPE_INDEX.J;   // a normal row above
  return state;
}

/** Per column of board row y: 'W' flash, 'L' L-colored, '.' empty. */
function rowPattern(canvas, y) {
  let out = '';
  for (let x = 0; x < 10; x++) {
    const px = rgb(cellCenter(canvas, x, y)).join();
    out += px === hex(COLORS.flash).join() ? 'W' : px === hex(PALETTE[TYPE_INDEX.L].face).join() ? 'L' : px === '0,0,0' ? '.' : '?';
  }
  return out;
}

test('line clear render: cleared rows flash white, then wipe from the center outward', () => {
  const expected = { 0: 'WWWWWWWWWW', 4: 'LLLL..LLLL', 8: 'WWW....WWW', 12: 'LL......LL', 16: 'W........W' };
  for (const [timer, pattern] of Object.entries(expected)) {
    const { boardCanvas, renderer } = setup();
    renderer.render(clearingState(Number(timer)));
    assert.equal(rowPattern(boardCanvas, 21), pattern, `timer ${timer}`);
  }
});

test('line clear render: other rows draw normally', () => {
  const { boardCanvas, renderer } = setup();
  renderer.render(clearingState(0));
  assert.deepEqual(rgb(cellCenter(boardCanvas, 0, 20)), hex(PALETTE[TYPE_INDEX.J].face));
});

test('line clear render: tetris flashes the whole well on white beats only', () => {
  const lift = (canvas) => canvas.pixel(5 * 16 + 8, 2 * 16 + 8)[0];   // an empty cell high up
  const tetris = [18, 19, 20, 21];
  const on = setup();
  on.renderer.render(clearingState(0, tetris));
  assert.equal(lift(on.boardCanvas), Math.round(0.25 * 252), 'white beat');
  const off = setup();
  off.renderer.render(clearingState(4, tetris));
  assert.equal(lift(off.boardCanvas), 0, 'color beat');
  const single = setup();
  single.renderer.render(clearingState(0));
  assert.equal(lift(single.boardCanvas), 0, 'singles do not flash the well');
});

// ---------- reduced motion ----------

function reducedSetup() {
  const canvases = { boardCanvas: createFakeCanvas(160, 320), holdCanvas: createFakeCanvas(80, 48), nextCanvas: createFakeCanvas(80, 144) };
  let reduced = true;
  const renderer = createRenderer(canvases, { createCanvas: (w, h) => createFakeCanvas(w, h), reducedMotion: () => reduced });
  return { ...canvases, renderer, setReduced: (v) => { reduced = v; } };
}

test('reduced motion: cleared rows are cut immediately — no flash, no wipe', () => {
  for (const timer of [0, 4, 8, 19]) {
    const { boardCanvas, renderer } = reducedSetup();
    renderer.render(clearingState(timer));
    assert.equal(rowPattern(boardCanvas, 21), '..........', `timer ${timer}`);
    assert.deepEqual(rgb(cellCenter(boardCanvas, 0, 20)), hex(PALETTE[TYPE_INDEX.J].face), 'other rows untouched');
  }
});

test('reduced motion: no tetris well wash', () => {
  const { boardCanvas, renderer } = reducedSetup();
  renderer.render(clearingState(0, [18, 19, 20, 21]));
  assert.equal(boardCanvas.pixel(5 * 16 + 8, 2 * 16 + 8)[0], 0);
});

test('reduced motion is read live each frame', () => {
  const { boardCanvas, renderer, setReduced } = reducedSetup();
  setReduced(false);
  renderer.render(clearingState(0));
  assert.equal(rowPattern(boardCanvas, 21), 'WWWWWWWWWW');
  setReduced(true);
  renderer.render(clearingState(0));
  assert.equal(rowPattern(boardCanvas, 21), '..........');
});
