import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState, update, createClock, advanceClock, createGame, pauseGame, loadHiScore, saveHiScore,
} from '../src/game.js';
import { emptyActions } from '../src/input.js';
import { spawnPiece, getAbsoluteCells, TYPE_INDEX, PIECE_TYPES } from '../src/pieces.js';
import { dropDistance } from '../src/board.js';
import {
  STEP_MS, NEXT_COUNT, ARE_FRAMES, MAX_LOCK_RESETS, LINE_CLEAR_FRAMES, GAME_OVER_DELAY_FRAMES,
  LEVEL_UP_FLASH_FRAMES, HI_SCORE_KEY, MAX_START_LEVEL,
} from '../src/config.js';
import { getLockDelay, getGravity } from '../src/progression.js';

// ---------- helpers ----------

// Deterministic RNG (mulberry32), same as tests/pieces.test.js.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const A = (overrides = {}) => ({ ...emptyActions(), ...overrides });

const NES_FRAMES_PER_ROW = [
  48, 43, 38, 33, 28, 23, 18, 13, 8, 6,
  5, 5, 5, 4, 4, 4, 3, 3, 3, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 1,
];

/** A state that has just left the title screen (one update consumed). */
function started({ level = 0, seed = 1 } = {}) {
  const state = createInitialState({ startLevel: level, rng: seeded(seed) });
  update(state, A({ start: true }), []);
  return state;
}

/** Runs n updates with the same actions; returns every event pushed. */
function run(state, n, actions = A()) {
  const events = [];
  for (let i = 0; i < n; i++) update(state, actions, events);
  return events;
}

/** Runs the line-clear animation to the end (rows collapse, score/lines applied); leaves ARE. */
function finishClear(state) {
  assert.equal(state.phase, 'lineClear', 'finishClear() expects the lineClear phase');
  return run(state, LINE_CLEAR_FRAMES);
}

/** Waits out the game-over input delay, then presses Enter (→ title). */
function leaveGameOver(state) {
  assert.equal(state.phase, 'gameOver');
  run(state, GAME_OVER_DELAY_FRAMES);
  update(state, A({ start: true }), []);
  assert.equal(state.phase, 'title');
}

/** Runs out the ARE entry delay after a lock so the next piece is spawned. */
function settle(state) {
  assert.equal(state.phase, 'are', 'settle() expects the ARE phase');
  return run(state, ARE_FRAMES);
}

/** Rows the active piece can still fall — 0 means grounded. */
function dropDistanceOf(state) {
  let d = 0;
  const p = { ...state.active };
  for (;;) {
    p.y++;
    if (getAbsoluteCells(p).some(([x, y]) => y >= 22 || x < 0 || x > 9 || state.board.cells[y][x])) return d;
    d++;
  }
}

const cellsOf = (state) => getAbsoluteCells(state.active).map(([x, y]) => `${x},${y}`).sort();
const filledCount = (board) => board.cells.reduce((n, row) => n + row.filter(Boolean).length, 0);

function fillRow(board, y, exceptCols = []) {
  board.cells[y].fill(1);
  for (const x of exceptCols) board.cells[y][x] = 0;
}

// ---------- initial state & phases ----------

test('createInitialState: full SPEC §7 shape in the title phase', () => {
  const state = createInitialState({ startLevel: 7, hiScore: 1234, rng: seeded(3) });
  assert.deepEqual(Object.keys(state).sort(), [
    'active', 'areTimer', 'bag', 'board', 'clearing', 'frame', 'gameOverTimer', 'gravityAcc',
    'hiScore', 'hold', 'level', 'levelUpFlash', 'lines', 'lock', 'newHiScore', 'pausedFrom',
    'phase', 'queue', 'rng', 'score', 'startLevel', 'stats',
  ]);
  assert.equal(state.phase, 'title');
  assert.equal(state.level, 7);
  assert.equal(state.hiScore, 1234);
  assert.equal(state.active, null);
  assert.equal(state.queue.length, NEXT_COUNT);
  assert.deepEqual(state.queue, state.bag.peek(NEXT_COUNT));
  assert.deepEqual(state.hold, { type: null, used: false });
  assert.deepEqual(state.stats, { pieces: 0, singles: 0, doubles: 0, triples: 0, tetrises: 0 });
});

test('title: waits for start, then spawns the first piece one row into view', () => {
  const state = createInitialState({ rng: seeded(1) });
  run(state, 30);
  assert.equal(state.phase, 'title');
  assert.equal(state.active, null);

  update(state, A({ start: true }), []);
  assert.equal(state.phase, 'playing');
  assert.equal(state.active.y, 1);
  assert.equal(state.active.x, 3);
  assert.equal(state.active.rotation, 0);
  assert.equal(state.queue.length, NEXT_COUNT);
});

test('frame counter advances in every phase and survives newGame', () => {
  const state = createInitialState({ rng: seeded(1) });
  run(state, 5);
  update(state, A({ start: true }), []);
  assert.equal(state.frame, 6);
  run(state, 4);
  assert.equal(state.frame, 10);
});

test('seeded games deal the same sequence; the queue previews the next pieces', () => {
  const a = started({ seed: 9 });
  const b = started({ seed: 9 });
  assert.equal(a.active.type, b.active.type);
  assert.deepEqual(a.queue, b.queue);
  const expectedNext = a.queue[0];
  run(a, 1, A({ hardDrop: true }));
  settle(a);
  assert.equal(a.active.type, expectedNext);
  assert.equal(a.queue.length, NEXT_COUNT);
});

test('gameOver: waits for start → title → start gives a fresh board, same settings', () => {
  const state = started({ level: 4, seed: 2 });
  state.board.cells[1][4] = 1;                 // guarantees block out on next spawn
  state.hiScore = 999;
  run(state, 1, A({ hardDrop: true }));
  settle(state);
  assert.equal(state.phase, 'gameOver');

  run(state, 10);
  update(state, A({ start: true }), []);
  assert.equal(state.phase, 'gameOver', 'Enter ignored during the game-over delay');
  leaveGameOver(state);
  assert.equal(filledCount(state.board), 0, 'title shows a clean board');
  update(state, A({ start: true }), []);
  assert.equal(state.phase, 'playing');
  assert.equal(filledCount(state.board), 0);
  assert.equal(state.lines, 0);
  assert.equal(state.stats.pieces, 0);
  assert.equal(state.level, 4);
  assert.equal(state.hiScore, 999);
});

// ---------- gravity physics ----------

test('gravity: levels 0–29 step exactly every framesPerRow frames down the whole well, then lock after the delay', () => {
  NES_FRAMES_PER_ROW.forEach((f, level) => {
    const state = started({ level });
    state.active = { type: 'T', rotation: 0, x: 3, y: 1 };
    const moves = [];
    let frame = 0;
    while (state.stats.pieces === 0) {
      const y = state.active.y;
      update(state, A(), []);
      frame++;
      if (state.stats.pieces === 0 && state.active.y !== y) moves.push(frame);
      assert.ok(frame <= 20 * f + 60, `level ${level} never locked`);
    }
    // T falls from y=1 to y=20 (19 rows). The landing frame starts the lock
    // timer at 1, so it locks getLockDelay − 1 frames later.
    assert.deepEqual(moves, Array.from({ length: 19 }, (_, i) => (i + 1) * f), `level ${level} row timing`);
    assert.equal(frame, 19 * f + getLockDelay(level) - 1, `level ${level} lock frame`);
  });
});

test('gravity: 5f − 1 frames → 4 rows, 5f frames → 5 rows (levels 0–28)', () => {
  for (let level = 0; level <= 28; level++) {
    const f = NES_FRAMES_PER_ROW[level];
    const state = started({ level });
    run(state, 5 * f - 1);
    assert.equal(state.active.y, 1 + 4, `level ${level}`);
    run(state, 1);
    assert.equal(state.active.y, 1 + 5, `level ${level}`);
  }
});

test('gravity: multi-G levels move floor(n × G) rows until landing', () => {
  const state = started({ level: 30 });       // G = 1 + 19/70 ≈ 1.271
  run(state, 5);
  assert.equal(state.active.y, 1 + 6);
  run(state, 5);
  assert.equal(state.active.y, 1 + 12);
});

test('gravity: level 99 (20 G) lands on the first frame, then locks after its 12-frame delay', () => {
  const state = started({ level: 99 });
  const first = state.active.type;
  assert.equal(getLockDelay(99), 12);
  run(state, 1);
  assert.equal(dropDistanceOf(state), 0, 'on the floor after one frame');
  run(state, 10);
  assert.equal(state.stats.pieces, 0, 'still movable on frame 11');
  const events = run(state, 1);
  assert.equal(state.stats.pieces, 1, 'locks on frame 12');
  assert.ok(events.includes('lock'));
  assert.equal(filledCount(state.board), 4);
  assert.ok(state.board.cells[21].some((v) => v === TYPE_INDEX[first]));
  settle(state);
  assert.equal(state.phase, 'playing', 'next piece spawned');
});

test('gravity: 20 G still leaves time to slide along the floor', () => {
  const state = started({ level: 99 });
  run(state, 1);
  const x = state.active.x;
  run(state, 3, A({ shift: -1 }));
  assert.equal(state.active.x, x - 3);
  assert.equal(state.stats.pieces, 0);
});

test('gravity: accumulator resets for each new piece', () => {
  const state = started({ level: 0 });
  run(state, 30);                              // acc = 30/48
  run(state, 1, A({ hardDrop: true }));
  settle(state);
  assert.equal(state.gravityAcc, 0);
  const y = state.active.y;
  run(state, 47);
  assert.equal(state.active.y, y);
  run(state, 1);
  assert.equal(state.active.y, y + 1);
});

test('soft drop: 1 row per 2 frames at level 0, no slowdown at level 29', () => {
  const slow = started({ level: 0 });
  run(slow, 10, A({ softDrop: true }));
  assert.equal(slow.active.y, 1 + 5);

  const fast = started({ level: 29 });
  run(fast, 10, A({ softDrop: true }));
  assert.equal(fast.active.y, 1 + 10);
});

test('soft drop lands, then waits out the lock delay (no instant lock)', () => {
  const state = started({ level: 0 });
  state.active = { type: 'T', rotation: 0, x: 3, y: 18 };
  run(state, 4, A({ softDrop: true }));        // frame 2 → y 19, frame 4 → y 20 (grounded)
  assert.equal(state.active.y, 20);
  run(state, 28, A({ softDrop: true }));       // lock timer 1 → 29
  assert.equal(state.stats.pieces, 0);
  run(state, 1, A({ softDrop: true }));        // timer 30 → lock
  assert.equal(state.stats.pieces, 1);
});

// ---------- movement ----------

test('shift: moves one column and emits move; blocked by walls without an event', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 10 };
  assert.deepEqual(run(state, 1, A({ shift: 1 })), ['move']);
  assert.equal(state.active.x, 4);

  state.active = { type: 'T', rotation: 0, x: 0, y: 10 };
  assert.deepEqual(run(state, 1, A({ shift: -1 })), []);
  assert.equal(state.active.x, 0);

  state.active = { type: 'T', rotation: 0, x: 7, y: 10 };
  assert.deepEqual(run(state, 1, A({ shift: 1 })), []);
  assert.equal(state.active.x, 7);
});

test('shift: blocked by the stack', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 10 };
  state.board.cells[11][2] = 1;
  run(state, 1, A({ shift: -1 }));
  assert.equal(state.active.x, 3);
});

test('shiftToWall: slides to the wall in one frame with a single move event', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 10 };
  assert.deepEqual(run(state, 1, A({ shift: -1, shiftToWall: true })), ['move']);
  assert.equal(Math.min(...getAbsoluteCells(state.active).map(([x]) => x)), 0);

  state.active = { type: 'I', rotation: 1, x: 3, y: 10 };
  run(state, 1, A({ shift: 1, shiftToWall: true }));
  assert.equal(Math.max(...getAbsoluteCells(state.active).map(([x]) => x)), 9);

  assert.deepEqual(run(state, 1, A({ shift: 1, shiftToWall: true })), [], 'already at wall');
});

// ---------- rotation ----------

test('rotate: CW and CCW in open space emit rotate', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 10 };
  assert.deepEqual(run(state, 1, A({ rotate: 1 })), ['rotate']);
  assert.deepEqual([state.active.rotation, state.active.x, state.active.y], [1, 3, 10]);

  state.active = { type: 'T', rotation: 0, x: 3, y: 10 };
  run(state, 1, A({ rotate: -1 }));
  assert.equal(state.active.rotation, 3);
});

test('rotate: T wall kick off the left wall (1 → 2 uses kick [+1, 0])', () => {
  const state = started();
  state.active = { type: 'T', rotation: 1, x: -1, y: 10 };
  run(state, 1, A({ rotate: 1 }));
  assert.deepEqual([state.active.rotation, state.active.x, state.active.y], [2, 0, 10]);
});

test('rotate: I wall kick off the right wall (1 → 2 uses kick [-1, 0])', () => {
  const state = started();
  state.active = { type: 'I', rotation: 1, x: 7, y: 10 };
  run(state, 1, A({ rotate: 1 }));
  assert.deepEqual([state.active.rotation, state.active.x, state.active.y], [2, 6, 10]);
});

test('rotate: floor kick moves the piece up (0 → 1 uses kick [-1, -1] y-down)', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  run(state, 1, A({ rotate: 1 }));
  assert.deepEqual([state.active.rotation, state.active.x, state.active.y], [1, 2, 19]);
});

test('rotate: blocked on all 5 kicks leaves the piece untouched and silent', () => {
  const state = started();
  for (let y = 5; y < 22; y++) fillRow(state.board, y);
  state.active = { type: 'T', rotation: 0, x: 3, y: 10 };
  for (const [x, y] of getAbsoluteCells(state.active)) state.board.cells[y][x] = 0;
  const before = cellsOf(state);
  const events = run(state, 1, A({ rotate: 1 }));
  assert.ok(!events.includes('rotate'));
  assert.equal(state.active.rotation, 0);
  assert.deepEqual(cellsOf(state), before);
});

test('rotation is applied before shifting in the same frame', () => {
  const state = started();
  state.active = { type: 'T', rotation: 1, x: -1, y: 10 };
  run(state, 1, A({ rotate: 1, shift: 1 }));   // kick to x=0, then shift to x=1
  assert.deepEqual([state.active.rotation, state.active.x], [2, 1]);
});

// ---------- hard drop, locking, clears ----------

test('hard drop from spawn: locks T at the floor, then ARE, then the next piece', () => {
  const state = started({ seed: 4 });
  state.active = spawnPiece('T');
  state.active.y = 1;
  const next = state.queue[0];
  const events = run(state, 1, A({ hardDrop: true }));
  const T = TYPE_INDEX.T;
  assert.deepEqual([...state.board.cells[21].slice(3, 6)], [T, T, T]);
  assert.equal(state.board.cells[20][4], T);
  assert.equal(filledCount(state.board), 4);
  assert.deepEqual(events, ['hardDrop', 'lock']);
  assert.equal(state.stats.pieces, 1);
  assert.equal(state.phase, 'are');
  assert.equal(state.active, null);
  settle(state);
  assert.equal(state.phase, 'playing');
  assert.equal(state.active.type, next);
  assert.equal(state.active.y, 1);
});

test('hard drop happens after rotate and shift in the same frame', () => {
  const state = started();
  state.active = { type: 'I', rotation: 0, x: 3, y: 1 };
  run(state, 1, A({ rotate: 1, shift: 1, hardDrop: true }));
  // I rotation 1 occupies box column 2 → board column 3 + 2 + 1 = 6
  for (let y = 18; y < 22; y++) assert.equal(state.board.cells[y][6], TYPE_INDEX.I, `row ${y}`);
});

test('single: row 21 open at cols 3–6, I hard drop clears it', () => {
  const state = started();
  fillRow(state.board, 21, [3, 4, 5, 6]);
  state.active = spawnPiece('I');
  const events = run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  assert.equal(state.lines, 1);
  assert.equal(state.stats.singles, 1);
  assert.equal(filledCount(state.board), 0);
  assert.ok(events.includes('clear'));
});

test('double: stack above cleared rows shifts down', () => {
  const state = started();
  fillRow(state.board, 20, [0]);
  fillRow(state.board, 21, [0]);
  state.active = { type: 'I', rotation: 3, x: -1, y: 2 };   // column 0, rows y..y+3
  run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  assert.equal(state.lines, 2);
  assert.equal(state.stats.doubles, 1);
  // I's upper two cells (rows 18–19) drop to rows 20–21
  assert.equal(state.board.cells[20][0], TYPE_INDEX.I);
  assert.equal(state.board.cells[21][0], TYPE_INDEX.I);
  assert.equal(filledCount(state.board), 2);
});

test('tetris: rows 18–21 open at col 0, vertical I clears all four', () => {
  const state = started();
  for (let y = 18; y < 22; y++) fillRow(state.board, y, [0]);
  state.active = { type: 'I', rotation: 3, x: -1, y: 2 };
  const events = run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  assert.equal(state.lines, 4);
  assert.equal(state.stats.tetrises, 1);
  assert.equal(filledCount(state.board), 0);
  assert.ok(events.includes('tetris'));
  assert.ok(!events.includes('clear'));
});

test('lines accumulate across clears', () => {
  const state = started();
  for (let i = 0; i < 3; i++) {
    fillRow(state.board, 21, [3, 4, 5, 6]);
    state.active = spawnPiece('I');
    run(state, 1, A({ hardDrop: true }));
    finishClear(state);
    settle(state);
  }
  assert.equal(state.lines, 3);
  assert.equal(state.stats.singles, 3);
});

// ---------- spawning & game over ----------

test('spawn stays in the hidden rows when the row below is blocked', () => {
  const state = started();
  for (let x = 3; x <= 6; x++) state.board.cells[2][x] = 1;
  state.active = { type: 'O', rotation: 0, x: -1, y: 18 };  // off to the side
  run(state, 1, A({ hardDrop: true }));
  settle(state);
  assert.equal(state.phase, 'playing');
  assert.equal(state.active.y, 0);
});

test('block out: next spawn (after ARE) overlaps the stack → gameOver', () => {
  const state = started();
  state.board.cells[1][4] = 1;               // every spawn shape covers (4, 1)
  state.active = { type: 'T', rotation: 0, x: 0, y: 10 };
  assert.deepEqual(run(state, 1, A({ hardDrop: true })), ['hardDrop', 'lock']);
  assert.deepEqual(settle(state), ['gameOver']);
  assert.equal(state.phase, 'gameOver');
  assert.equal(state.active, null);
});

test('block out covers every piece type', () => {
  for (const type of PIECE_TYPES) {
    const cells = getAbsoluteCells(spawnPiece(type)).map(([x, y]) => `${x},${y}`);
    assert.ok(cells.includes('4,1'), type);
  }
});

test('lock out: piece locking entirely in hidden rows → gameOver', () => {
  const state = started();
  for (let x = 3; x <= 5; x++) state.board.cells[2][x] = 1;
  state.active = spawnPiece('T');            // rows 0–1, can't drop
  const events = run(state, 1, A({ hardDrop: true }));
  assert.equal(state.phase, 'gameOver');
  assert.ok(events.includes('gameOver'));
  assert.equal(state.stats.pieces, 1);
});

test('lock out away from the spawn area ends the game even though the next spawn would fit', () => {
  const state = started();
  for (let x = 0; x <= 2; x++) state.board.cells[2][x] = 1;
  state.active = { type: 'T', rotation: 0, x: 0, y: 0 };   // rows 0–1, cols 0–2, can't drop
  const events = run(state, 1, A({ hardDrop: true }));
  assert.equal(state.phase, 'gameOver');
  assert.deepEqual(events, ['hardDrop', 'lock', 'gameOver']);
  assert.equal(state.board.cells[1][0], TYPE_INDEX.T, 'piece was locked before game over');
});

test('lock out via the lock delay as well as hard drop', () => {
  const state = started({ level: 29 });
  for (let x = 3; x <= 5; x++) state.board.cells[2][x] = 1;
  state.active = spawnPiece('T');
  run(state, getLockDelay(29) - 1);
  assert.equal(state.phase, 'playing');
  run(state, 1);
  assert.equal(state.phase, 'gameOver');
});

test('no lock out when part of the piece is visible', () => {
  const state = started();
  for (let x = 0; x <= 2; x++) state.board.cells[3][x] = 1;
  state.active = { type: 'T', rotation: 0, x: 0, y: 1 };   // rows 1–2, row 2 visible
  run(state, 1, A({ hardDrop: true }));
  assert.equal(state.phase, 'are');
  assert.equal(state.stats.pieces, 1);
  settle(state);
  assert.equal(state.phase, 'playing');
});

test('gameOver ignores gameplay input', () => {
  const state = started();
  state.board.cells[1][4] = 1;
  run(state, 1, A({ hardDrop: true }));
  settle(state);
  const snapshot = state.board.cells.map((r) => [...r]);
  run(state, 20, A({ hardDrop: true, shift: -1, rotate: 1, softDrop: true }));
  assert.equal(state.phase, 'gameOver');
  assert.deepEqual(state.board.cells.map((r) => [...r]), snapshot);
});

// ---------- clock ----------

function clockSteps(deltas, stepMs) {
  const clock = createClock();
  let t = 5000;
  const first = advanceClock(clock, t, stepMs);
  const steps = deltas.map((d) => advanceClock(clock, (t += d), stepMs));
  return { first, steps, total: steps.reduce((a, b) => a + b, 0), clock };
}

test('clock: first call only records the timestamp', () => {
  const clock = createClock();
  assert.equal(advanceClock(clock, 12345), 0);
  assert.equal(clock.last, 12345);
  assert.equal(clock.acc, 0);
});

test('clock: steady 16.667 ms → exactly 1 step per frame', () => {
  const { first, steps, total } = clockSteps(Array(60).fill(16.667));
  assert.equal(first, 0);
  assert.ok(steps.every((s) => s === 1));
  assert.equal(total, 60);
});

/** rAF timestamps as browsers deliver them: vsync ticks plus non-accumulating noise. */
function vsyncStamps(frames, periodMs, noiseMs, seed = 11) {
  const rnd = seeded(seed);
  return Array.from({ length: frames + 1 }, (_, k) => 5000 + k * periodMs + (rnd() * 2 - 1) * noiseMs);
}

function histogram(stamps, advance) {
  const clock = createClock();
  advance(clock, stamps[0]);
  const counts = {};
  for (const t of stamps.slice(1)) {
    const s = advance(clock, t);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

// Same as advanceClock but without CLOCK_SLOP_MS — the bug the slack fixes.
function naiveAdvance(clock, now) {
  if (clock.last === null) { clock.last = now; return 0; }
  clock.acc += Math.min(Math.max(0, now - clock.last), 250);
  clock.last = now;
  const steps = Math.floor(clock.acc / STEP_MS);
  clock.acc -= steps * STEP_MS;
  return steps;
}

test('clock: 60 Hz vsync with up to ±0.4 ms timestamp noise → exactly 1 step every frame (slack fix)', () => {
  for (const noise of [0.05, 0.2, 0.4]) {
    assert.deepEqual(histogram(vsyncStamps(3600, STEP_MS, noise), (c, t) => advanceClock(c, t)), { 1: 3600 },
      `noise ±${noise} ms`);
  }
});

test('clock: realistic rAF timestamps quantized to 0.1 ms stay at 1 step per frame', () => {
  const clock = createClock();
  const stamps = Array.from({ length: 601 }, (_, i) => Math.round((1000 + i * STEP_MS) * 10) / 10);
  advanceClock(clock, stamps[0]);
  const steps = stamps.slice(1).map((t) => advanceClock(clock, t));
  assert.ok(steps.every((s) => s === 1), `got ${[...new Set(steps)]}`);
});

test('clock: without slack the same timestamps stutter between 0 and 2 steps (documents CLOCK_SLOP_MS)', () => {
  // Anchoring on the first timestamp leaves the accumulator on a step boundary,
  // so any noise flips frames between 0 and 2 updates.
  const counts = histogram(vsyncStamps(3600, STEP_MS, 0.2), naiveAdvance);
  assert.ok(counts[0] > 100 && counts[2] > 100, JSON.stringify(counts));
});

test('clock: off-rate displays stay real-time with rare single corrections', () => {
  // 59.94 Hz is slightly slow → an occasional double step, never a skipped frame
  const slow = histogram(vsyncStamps(3600, 1000 / 59.94, 0), (c, t) => advanceClock(c, t));
  assert.equal(slow[0], undefined);
  assert.ok(slow[2] >= 1 && slow[2] <= 4, JSON.stringify(slow));
  const elapsedSteps = (3600 * (1000 / 59.94)) / STEP_MS;       // 3603.6 steps of real time
  assert.ok(Math.abs(slow[1] + 2 * slow[2] - elapsedSteps) < 1, 'total tracks real time');

  // 60.006 Hz is slightly fast → an occasional frame with no step, never a double
  const fast = histogram(vsyncStamps(3600, 1000 / 60.006, 0), (c, t) => advanceClock(c, t));
  assert.equal(fast[2], undefined);
  assert.ok(fast[0] >= 1 && fast[0] <= 2, JSON.stringify(fast));
});

test('clock: 144 Hz → 60 ± 1 steps per second, at most 1 per frame', () => {
  const { steps, total } = clockSteps(Array(144).fill(1000 / 144));
  assert.ok(Math.abs(total - 60) <= 1, `total ${total}`);
  assert.ok(steps.every((s) => s <= 1));
});

test('clock: 30 Hz → 2 steps per frame', () => {
  const { steps } = clockSteps(Array(30).fill(1000 / 30));
  assert.ok(steps.every((s) => s === 2), `got ${[...new Set(steps)]}`);
});

test('clock: long stall is clamped to MAX_FRAME_MS (15 steps)', () => {
  assert.deepEqual(clockSteps([1000]).steps, [15]);
  assert.deepEqual(clockSteps([60_000]).steps, [15]);
});

test('clock: timestamps going backwards run no steps', () => {
  const clock = createClock();
  advanceClock(clock, 1000);
  assert.equal(advanceClock(clock, 900), 0);
  assert.equal(advanceClock(clock, 900 + STEP_MS), 1);
});

test('clock: accumulator never drifts beyond the slack', () => {
  const { clock } = clockSteps(Array.from({ length: 5000 }, (_, i) => 5 + (i * 7919) % 30));
  assert.ok(clock.acc > -0.5 - 1e-9 && clock.acc < STEP_MS, `acc ${clock.acc}`);
});

test('clock: honors a custom step length', () => {
  assert.deepEqual(clockSteps([10, 10, 10], 10).steps, [1, 1, 1]);
});

// ---------- loop ----------

function fakeRaf() {
  let pending = null;
  let nextId = 0;
  const api = {
    cancelled: [],
    raf(cb) { pending = { cb, id: ++nextId }; return nextId; },
    caf(id) { api.cancelled.push(id); if (pending?.id === id) pending = null; },
    /** Fires the pending callback at time t. Returns false if nothing was scheduled. */
    tick(t) { const p = pending; pending = null; if (!p) return false; p.cb(t); return true; },
    get pending() { return pending !== null; },
  };
  return api;
}

function loopHarness({ level = 0, storage = null } = {}) {
  const clock = fakeRaf();
  const input = {
    queue: [], resets: 0, polls: 0,
    poll() { this.polls++; return this.queue.shift() ?? emptyActions(); },
    reset() { this.resets++; },
  };
  const renderer = { calls: 0, render() { this.calls++; } };
  const ui = { calls: 0, update() { this.calls++; } };
  const audio = { played: [], play(name) { this.played.push(name); } };
  const game = createGame({
    input, renderer, ui, audio,
    initialState: createInitialState({ startLevel: level, rng: seeded(5) }),
    storage,
    raf: clock.raf, caf: clock.caf,
  });
  let t = 1000;
  const frame = (dt = STEP_MS) => clock.tick((t += dt));
  return { game, clock, input, renderer, ui, audio, frame, state: game.getState() };
}

test('loop: start is idempotent and schedules one frame', () => {
  const h = loopHarness();
  h.game.start();
  h.game.start();
  assert.ok(h.clock.pending);
  assert.ok(h.frame());
  assert.ok(h.clock.pending, 'reschedules itself');
  assert.equal(h.renderer.calls, 1);
});

test('loop: first frame renders but does not simulate; then one update per 60 Hz frame', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  assert.equal(h.state.frame, 0);
  assert.equal(h.input.polls, 0);
  for (let i = 0; i < 60; i++) h.frame();
  assert.equal(h.state.frame, 60);
  assert.equal(h.input.polls, 60, 'input polled once per step');
  assert.equal(h.renderer.calls, 61);
  assert.equal(h.ui.calls, 61);
});

test('loop: forwards update events to audio', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  h.input.queue.push(A({ start: true }), A({ hardDrop: true }));
  h.frame();
  h.frame();
  assert.deepEqual(h.audio.played, ['hardDrop', 'lock']);
});

test('loop: input.reset on menu transitions only, not between pieces', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  h.input.queue.push(A({ start: true }));
  h.frame();
  assert.equal(h.state.phase, 'playing');
  assert.equal(h.input.resets, 1, 'title → playing');

  const lockAndSpawn = () => {
    h.input.queue.push(A({ hardDrop: true }));
    for (let i = 0; i <= ARE_FRAMES; i++) h.frame();         // drop + full ARE
  };
  lockAndSpawn();
  lockAndSpawn();
  assert.equal(h.state.stats.pieces, 2);
  assert.equal(h.state.phase, 'playing');
  assert.equal(h.input.resets, 1, 'playing → are → playing keeps DAS charge');

  h.state.board.cells[1][4] = 1;
  lockAndSpawn();
  assert.equal(h.state.phase, 'gameOver');
  assert.equal(h.input.resets, 2, 'playing → gameOver');
});

test('loop: 30 Hz display runs 2 updates per frame with fresh input each', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  h.frame(1000 / 30);
  assert.equal(h.state.frame, 2);
  assert.equal(h.input.polls, 2);
});

test('loop: stall catch-up is capped at 15 updates', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  h.frame(5000);
  assert.equal(h.state.frame, 15);
});

test('loop: stop cancels the pending frame; restart has no catch-up burst', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  h.frame();
  h.game.stop();
  assert.equal(h.clock.cancelled.length, 1);
  assert.ok(!h.clock.pending);
  assert.equal(h.frame(), false);

  h.game.start();
  h.frame(10_000);                              // long gap while stopped
  assert.equal(h.state.frame, 1, 'first frame after restart only re-anchors the clock');
  h.frame();
  assert.equal(h.state.frame, 2);
});

test('loop: game speed is identical at 60 Hz and 144 Hz', () => {
  const at = (hz) => {
    const h = loopHarness({ level: 0 });
    h.game.start();
    h.frame();
    h.input.queue.push(A({ start: true }));
    for (let i = 0; i < hz * 2; i++) h.frame(1000 / hz);   // 2 seconds
    return { frame: h.state.frame, y: h.state.active.y };
  };
  const a = at(60);
  const b = at(144);
  assert.ok(Math.abs(a.frame - b.frame) <= 1, `${a.frame} vs ${b.frame}`);
  assert.equal(a.y, b.y);
});

// ===========================================================================
// Milestone 3
// ===========================================================================

// ---------- scoring ----------

test('score: single at level 0 = 40 + hard drop 2/row', () => {
  const state = started();
  fillRow(state.board, 21, [3, 4, 5, 6]);
  state.active = spawnPiece('I');            // row 1 → row 21 = 20 rows
  run(state, 1, A({ hardDrop: true }));
  assert.equal(state.score, 2 * 20, 'drop points immediately');
  finishClear(state);
  assert.equal(state.score, 40 + 2 * 20, 'clear points when the rows collapse');
});

test('score: line clears use (level + 1) — tetris at level 9 = 12 000', () => {
  const state = started({ level: 9 });
  for (let y = 18; y < 22; y++) fillRow(state.board, y, [0]);
  state.active = { type: 'I', rotation: 3, x: -1, y: 2 };   // rows 2–5 → 18–21 = 16 rows
  run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  assert.equal(state.score, 12000 + 2 * 16);
});

test('score: double and triple values at level 5', () => {
  for (const [rows, points] of [[2, 100 * 6], [3, 300 * 6]]) {
    const state = started({ level: 5 });
    for (let y = 22 - rows; y < 22; y++) fillRow(state.board, y, [0]);
    state.active = { type: 'I', rotation: 3, x: -1, y: 10 };
    const distance = dropDistance(state.board, state.active);
    run(state, 1, A({ hardDrop: true }));
    finishClear(state);
    assert.equal(state.lines, rows);
    assert.equal(state.score, points + 2 * distance, `${rows} lines`);
  }
});

test('score: hard drop of zero rows scores nothing', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  run(state, 1, A({ hardDrop: true }));
  assert.equal(state.score, 0);
});

test('score: soft drop 1/row moved; plain gravity scores nothing', () => {
  const soft = started();
  run(soft, 10, A({ softDrop: true }));      // 5 rows at 0.5 G
  assert.equal(soft.score, 5);

  const plain = started();
  run(plain, 48 * 5);                         // 5 rows of normal gravity
  assert.equal(plain.active.y, 6);
  assert.equal(plain.score, 0);
});

test('score: soft drop on the floor earns nothing', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  run(state, 10, A({ softDrop: true }));
  assert.equal(state.score, 0);
});

test('score: soft drop at fast levels counts every row moved', () => {
  const state = started({ level: 29 });      // 1 G > SOFT_DROP_G
  run(state, 10, A({ softDrop: true }));
  assert.equal(state.score, 10);
});

test('hiScore: raised at game over, never lowered', () => {
  const state = started();
  state.hiScore = 50;
  fillRow(state.board, 21, [3, 4, 5, 6]);
  state.active = spawnPiece('I');
  run(state, 1, A({ hardDrop: true }));      // 80 points
  finishClear(state);
  state.board.cells[1][4] = 1;
  settle(state);
  assert.equal(state.phase, 'gameOver');
  assert.equal(state.hiScore, 80);

  const low = started();
  low.hiScore = 10_000;
  low.board.cells[1][4] = 1;
  run(low, 1, A({ hardDrop: true }));
  settle(low);
  assert.equal(low.hiScore, 10_000);
});

test('score resets on a new game, hiScore carries over', () => {
  const state = started();
  run(state, 1, A({ hardDrop: true }));
  state.board.cells[1][4] = 1;
  settle(state);
  const top = state.hiScore;
  assert.ok(top > 0);
  leaveGameOver(state);
  assert.equal(state.score, 0, 'title HUD already reset');
  update(state, A({ start: true }), []);
  assert.equal(state.score, 0);
  assert.equal(state.hiScore, top);
});

// ---------- hold ----------

test('hold (empty): parks the piece, deals the next one from the queue', () => {
  const state = started({ seed: 3 });
  const current = state.active.type;
  const [q0, q1, q2] = state.queue;
  const events = run(state, 1, A({ hold: true }));
  assert.deepEqual(events, ['hold']);
  assert.equal(state.hold.type, current);
  assert.equal(state.hold.used, true);
  assert.equal(state.active.type, q0);
  assert.deepEqual(state.queue.slice(0, 2), [q1, q2]);
  assert.equal(state.queue.length, NEXT_COUNT);
});

test('hold: only once per piece', () => {
  const state = started({ seed: 3 });
  run(state, 1, A({ hold: true }));
  const snapshot = JSON.stringify({ type: state.active.type, hold: state.hold, queue: state.queue });
  const events = run(state, 5, A({ hold: true }));
  assert.ok(!events.includes('hold'));
  assert.equal(JSON.stringify({ type: state.active.type, hold: state.hold, queue: state.queue }), snapshot);
});

test('hold: unlocked again after the next piece locks; swaps without touching the queue', () => {
  const state = started({ seed: 3 });
  const first = state.active.type;
  run(state, 1, A({ hold: true }));
  run(state, 1, A({ hardDrop: true }));
  assert.equal(state.hold.used, false);
  settle(state);
  const current = state.active.type;
  const queue = [...state.queue];
  assert.deepEqual(run(state, 1, A({ hold: true })), ['hold']);
  assert.equal(state.active.type, first, 'held piece comes back');
  assert.equal(state.hold.type, current);
  assert.deepEqual(state.queue, queue);
});

test('hold: swapped-in piece respawns at spawn position, rotation 0, fresh timers', () => {
  const state = started({ seed: 3 });
  run(state, 1, A({ hold: true }));
  run(state, 1, A({ hardDrop: true }));
  settle(state);
  state.active.rotation = 2;
  state.active.x = 0;
  state.active.y = 20;
  state.lock.timer = 25;
  state.lock.resets = 9;
  state.gravityAcc = 0.9;
  run(state, 1, A({ hold: true }));
  assert.deepEqual([state.active.rotation, state.active.x, state.active.y], [0, 3, 1]);
  assert.equal(state.lock.timer, 0);
  assert.equal(state.lock.resets, 0);
  assert.ok(state.gravityAcc < 0.1, 'gravity accumulator restarted');
});

test('hold: the swapped-in piece receives the rest of the frame input', () => {
  const state = started({ seed: 3 });
  const next = state.queue[0];
  run(state, 1, A({ hold: true, rotate: 1 }));
  assert.equal(state.active.type, next);
  assert.equal(state.active.rotation, 1);
});

test('hold: swapped-in piece that cannot spawn → gameOver', () => {
  const state = started({ seed: 3 });
  state.active = { type: 'T', rotation: 0, x: 0, y: 10 };
  state.board.cells[1][4] = 1;
  const events = run(state, 1, A({ hold: true }));
  assert.deepEqual(events, ['hold', 'gameOver']);
  assert.equal(state.phase, 'gameOver');
});

test('hold is ignored during ARE', () => {
  const state = started({ seed: 3 });
  run(state, 1, A({ hardDrop: true }));
  run(state, ARE_FRAMES - 1, A({ hold: true }));
  assert.equal(state.hold.type, null);
});

// ---------- next queue ----------

test('next queue: always NEXT_COUNT long; each spawn is the previous queue head', () => {
  const state = started({ seed: 21 });
  for (let i = 0; i < 60; i++) {
    const before = [...state.queue];
    run(state, 1, A({ hardDrop: true }));
    settle(state);
    assert.equal(state.active.type, before[0], `piece ${i}`);
    assert.deepEqual(state.queue.slice(0, NEXT_COUNT - 1), before.slice(1), `piece ${i}`);
    assert.equal(state.queue.length, NEXT_COUNT);
    state.board = createInitialState().board;  // keep the well empty so play continues
  }
});

test('next queue: dealt pieces follow the 7-bag', () => {
  const state = started({ seed: 8 });
  const dealt = [state.active.type];
  while (dealt.length < 49) {
    run(state, 1, A({ hardDrop: true }));
    settle(state);
    dealt.push(state.active.type);
    state.board = createInitialState().board;
  }
  for (let i = 0; i < 49; i += 7) {
    assert.deepEqual([...dealt.slice(i, i + 7)].sort(), [...PIECE_TYPES].sort(), `bag ${i / 7}`);
  }
});

// ---------- lock delay ----------

test('lock delay: a grounded piece locks after exactly getLockDelay frames', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  run(state, getLockDelay(0) - 1);
  assert.equal(state.stats.pieces, 0);
  assert.equal(state.lock.timer, getLockDelay(0) - 1);
  assert.deepEqual(run(state, 1), ['lock']);
  assert.equal(state.phase, 'are');
});

test('lock delay scales with level (level 64 → 21 frames)', () => {
  const state = started({ level: 64 });
  assert.ok(dropDistanceOf(state) > 0);
  while (dropDistanceOf(state) > 0) run(state, 1);   // 10.5 G: lands on frame 2
  let frames = 1;                             // the landing frame counts as timer 1
  while (state.stats.pieces === 0) { run(state, 1); frames++; }
  assert.equal(frames, getLockDelay(64));
});

test('lock delay: moving on the floor resets the timer', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  run(state, 20);
  assert.equal(state.lock.timer, 20);
  run(state, 1, A({ shift: 1 }));
  assert.equal(state.lock.timer, 1, 'reset, then counted this frame');
  assert.equal(state.lock.resets, 1);
  run(state, getLockDelay(0) - 2);
  assert.equal(state.stats.pieces, 0);
  run(state, 1);
  assert.equal(state.stats.pieces, 1);
});

test('lock delay: rotating on the floor resets the timer', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  run(state, 20);
  run(state, 1, A({ rotate: 1 }));            // floor kick
  assert.equal(state.lock.resets, 1);
  assert.ok(state.lock.timer <= 1);
});

test('lock delay: a failed move does not reset the timer', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 0, y: 20 };
  run(state, 20);
  run(state, 1, A({ shift: -1 }));            // into the wall
  assert.equal(state.lock.timer, 21);
  assert.equal(state.lock.resets, 0);
});

test('lock delay: at most MAX_LOCK_RESETS resets — endless sliding still locks', () => {
  assert.equal(MAX_LOCK_RESETS, 15);
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  let frame = 0;
  while (state.stats.pieces === 0) {
    run(state, 1, A({ shift: frame % 2 ? -1 : 1 }));
    frame++;
    assert.ok(frame < 200, 'piece stalled forever');
  }
  // Frame 1 only starts the timer; frames 2–16 spend the 15 resets; after
  // that the timer runs uninterrupted from 1 on frame 16 to 30 on frame 45.
  assert.equal(state.lock.resets, 15);
  assert.equal(frame, 1 + MAX_LOCK_RESETS + getLockDelay(0) - 1);
});

test('lock delay: sliding off a ledge stops the timer', () => {
  const state = started();
  state.board.cells[21][1] = 1;               // single-block ledge
  state.active = { type: 'T', rotation: 0, x: 0, y: 19 };  // resting on it
  run(state, 20);
  assert.equal(state.lock.timer, 20);
  run(state, 1, A({ shift: 1 }));             // cols 1–3: still supported
  run(state, 1, A({ shift: 1 }));             // cols 2–4: airborne
  assert.equal(state.lock.timer, 0);
  assert.equal(state.stats.pieces, 0);
});

test('lock delay: going airborne stops the timer even with no resets left', () => {
  const state = started();
  state.board.cells[21][1] = 1;
  state.active = { type: 'T', rotation: 0, x: 0, y: 19 };
  state.lock.lowestY = 19;
  run(state, 1);
  for (let i = 0; i < 15; i++) run(state, 1, A({ shift: i % 2 ? -1 : 1 }));  // spend all 15 resets
  run(state, 5);
  assert.equal(state.lock.resets, 15);
  assert.ok(state.lock.timer > 1);
  run(state, 1, A({ shift: 1 }));             // off the ledge — no reset available
  assert.equal(state.lock.timer, 0);
});

test('lock delay: reaching a new lowest row restores the reset budget', () => {
  const state = started();
  state.board.cells[21][1] = 1;
  state.active = { type: 'T', rotation: 0, x: 0, y: 19 };
  state.lock.lowestY = 19;
  run(state, 1);                              // start the timer
  for (let i = 0; i < 15; i++) run(state, 1, A({ shift: i % 2 ? -1 : 1 }));  // x 0 ↔ 1, both supported
  assert.equal(state.lock.resets, 15);
  assert.equal(state.active.x, 1);
  run(state, 1, A({ shift: 1 }));             // x = 2: off the ledge
  run(state, 4, A({ softDrop: true }));       // falls to y = 20
  assert.equal(state.active.y, 20);
  assert.equal(state.lock.lowestY, 20);
  assert.equal(state.lock.resets, 0);
});

test('lock delay: floor kicks upward do not refresh the reset budget', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  state.lock.lowestY = 20;
  run(state, 2);
  run(state, 1, A({ rotate: 1 }));            // kicks up to y = 19
  assert.equal(state.active.y, 19);
  assert.equal(state.lock.resets, 1);
  assert.equal(state.lock.lowestY, 20);
});

test('lock delay: hard drop still locks immediately', () => {
  const state = started();
  assert.deepEqual(run(state, 1, A({ hardDrop: true })), ['hardDrop', 'lock']);
});

// ---------- ARE ----------

test('ARE: ARE_FRAMES frames with no piece, spawn on the last one', () => {
  assert.equal(ARE_FRAMES, 6);
  const state = started();
  run(state, 1, A({ hardDrop: true }));
  for (let i = 1; i < ARE_FRAMES; i++) {
    run(state, 1);
    assert.equal(state.phase, 'are', `ARE frame ${i}`);
    assert.equal(state.active, null);
  }
  run(state, 1);
  assert.equal(state.phase, 'playing');
  assert.ok(state.active);
});

test('ARE: gameplay input is ignored', () => {
  const state = started();
  run(state, 1, A({ hardDrop: true }));
  const board = state.board.cells.map((r) => [...r]);
  const score = state.score;
  run(state, ARE_FRAMES - 1, A({ hardDrop: true, softDrop: true, shift: 1, rotate: 1, hold: true }));
  assert.deepEqual(state.board.cells.map((r) => [...r]), board);
  assert.equal(state.score, score);
});

test('line clear: lineClear animation first, then the normal ARE', () => {
  const state = started();
  fillRow(state.board, 21, [3, 4, 5, 6]);
  state.active = spawnPiece('I');
  run(state, 1, A({ hardDrop: true }));
  assert.equal(state.phase, 'lineClear');
  finishClear(state);
  assert.equal(state.lines, 1);
  assert.equal(state.phase, 'are');
  settle(state);
  assert.equal(state.phase, 'playing');
});

// ---------- ghost projection ----------

test('ghost: y + board.dropDistance() is exactly where a hard drop lands (fuzzed)', () => {
  const rnd = seeded(77);
  let checked = 0;
  for (let n = 0; n < 400; n++) {
    const state = started({ seed: n + 1 });
    // Random jagged stack with holes and overhangs, never a full row
    for (let x = 0; x < 10; x++) {
      const height = Math.floor(rnd() * 14);
      for (let y = 21; y > 21 - height; y--) if (rnd() > 0.2) state.board.cells[y][x] = 1;
    }
    for (let y = 0; y < 22; y++) state.board.cells[y][Math.floor(rnd() * 10)] = 0;
    const type = PIECE_TYPES[Math.floor(rnd() * 7)];
    const piece = { type, rotation: Math.floor(rnd() * 4), x: Math.floor(rnd() * 10) - 2, y: Math.floor(rnd() * 4) };
    if (getAbsoluteCells(piece).some(([x, y]) => x < 0 || x > 9 || y > 21 || state.board.cells[y][x])) continue;

    // What the renderer will do: project with dropDistance, without touching the piece
    const originalY = piece.y;
    const ghostY = piece.y + dropDistance(state.board, piece);
    assert.equal(piece.y, originalY, 'dropDistance must not mutate');
    const ghostCells = getAbsoluteCells({ ...piece, y: ghostY });

    state.active = { ...piece };
    const before = filledCount(state.board);
    run(state, 1, A({ hardDrop: true }));
    if (state.lines > 0) continue;            // piece completed a row; the stack shifted
    for (const [x, y] of ghostCells) assert.equal(state.board.cells[y][x], TYPE_INDEX[type], `case ${n}`);
    assert.equal(filledCount(state.board), before + 4, `case ${n}`);
    checked++;
  }
  assert.ok(checked > 150, `only ${checked} valid cases`);
});

test('ghost: dropDistance leaves the piece untouched and matches brute force', () => {
  const state = started();
  state.board.cells[15][4] = 1;               // overhang over a cave
  const piece = Object.freeze({ type: 'T', rotation: 0, x: 3, y: 2 });
  const d = dropDistance(state.board, piece);  // throws in strict mode if it mutated a frozen object
  state.active = { ...piece };
  assert.equal(d, dropDistanceOf(state));
  assert.equal(piece.y + d, 13, 'stops on the overhang, not in the cave below');
});

// ===========================================================================
// Pause
// ===========================================================================

test('pause: P during play → paused with a pause event; P again resumes', () => {
  const state = started();
  assert.deepEqual(run(state, 1, A({ pause: true })), ['pause']);
  assert.equal(state.phase, 'paused');
  assert.equal(state.pausedFrom, 'playing');
  assert.deepEqual(run(state, 1, A({ pause: true })), ['pause']);
  assert.equal(state.phase, 'playing');
  assert.equal(state.pausedFrom, null);
});

test('pause: the pause frame itself does not advance the game', () => {
  const state = started({ level: 29 });      // 1 row per frame, so any tick would show
  const y = state.active.y;
  run(state, 1, A({ pause: true, shift: 1, hardDrop: true }));
  assert.equal(state.active.y, y);
  assert.equal(state.active.x, 3);
  assert.equal(state.stats.pieces, 0);
});

test('pause: gravity is frozen and resumes from the same accumulator', () => {
  const state = started({ level: 0 });
  run(state, 30);                             // 30/48 of a row
  const { y } = state.active;
  const acc = state.gravityAcc;
  run(state, 1, A({ pause: true }));
  run(state, 600);                            // 10 s paused
  assert.equal(state.active.y, y);
  assert.equal(state.gravityAcc, acc);
  run(state, 1, A({ pause: true }));          // resume (no gravity on this frame)
  run(state, 17);
  assert.equal(state.active.y, y, 'still 1/48 short');
  run(state, 1);
  assert.equal(state.active.y, y + 1, 'row lands on frame 48 of play time');
});

test('pause: lock delay timer is frozen', () => {
  const state = started();
  state.active = { type: 'T', rotation: 0, x: 3, y: 20 };
  run(state, 20);
  run(state, 1, A({ pause: true }));
  run(state, 300);
  assert.equal(state.lock.timer, 20);
  assert.equal(state.stats.pieces, 0);
  run(state, 1, A({ pause: true }));
  run(state, 9);
  assert.equal(state.stats.pieces, 0);
  run(state, 1);
  assert.equal(state.stats.pieces, 1, 'locks after the remaining 10 frames');
});

test('pause: works during ARE and resumes into ARE with the remaining time', () => {
  const state = started();
  run(state, 1, A({ hardDrop: true }));
  run(state, 2);                              // 2 of 6 ARE frames
  run(state, 1, A({ pause: true }));
  assert.equal(state.pausedFrom, 'are');
  run(state, 100);
  assert.equal(state.active, null);
  run(state, 1, A({ pause: true }));
  assert.equal(state.phase, 'are');
  run(state, ARE_FRAMES - 3);
  assert.equal(state.phase, 'are');
  run(state, 1);
  assert.equal(state.phase, 'playing');
});

test('pause: gameplay input and Enter are ignored while paused', () => {
  const state = started();
  run(state, 1, A({ pause: true }));
  const snapshot = JSON.stringify({ active: state.active, hold: state.hold, score: state.score });
  run(state, 30, A({ hardDrop: true, softDrop: true, shift: -1, shiftToWall: true, rotate: 1, hold: true, start: true }));
  assert.equal(state.phase, 'paused');
  assert.equal(JSON.stringify({ active: state.active, hold: state.hold, score: state.score }), snapshot);
});

test('pause: frame counter keeps running (drives the blinking prompt)', () => {
  const state = started();
  run(state, 1, A({ pause: true }));
  const frame = state.frame;
  run(state, 10);
  assert.equal(state.frame, frame + 10);
});

test('pause: ignored on the title screen and at game over', () => {
  const title = createInitialState({ rng: seeded(1) });
  assert.deepEqual(run(title, 1, A({ pause: true })), []);
  assert.equal(title.phase, 'title');

  const over = started();
  over.board.cells[1][4] = 1;
  run(over, 1, A({ hardDrop: true }));
  settle(over);
  assert.equal(over.phase, 'gameOver');
  assert.deepEqual(run(over, 1, A({ pause: true })), []);
  assert.equal(over.phase, 'gameOver');
});

test('pauseGame: only pauses playing / ARE', () => {
  for (const phase of ['title', 'gameOver', 'paused']) {
    const state = createInitialState();
    state.phase = phase;
    assert.equal(pauseGame(state), false, phase);
    assert.equal(state.phase, phase);
  }
  const state = started();
  assert.equal(pauseGame(state), true);
  assert.deepEqual([state.phase, state.pausedFrom], ['paused', 'playing']);
});

// ---------- loop integration ----------

test('loop: P pauses and resumes; input is reset on both transitions', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  h.input.queue.push(A({ start: true }));
  h.frame();
  const resets = h.input.resets;
  h.input.queue.push(A({ pause: true }));
  h.frame();
  assert.equal(h.state.phase, 'paused');
  assert.equal(h.input.resets, resets + 1);
  h.input.queue.push(A({ pause: true }));
  h.frame();
  assert.equal(h.state.phase, 'playing');
  assert.equal(h.input.resets, resets + 2);
  assert.deepEqual(h.audio.played, ['pause', 'pause']);
});

test('loop: game.pause() pauses play, resets input, plays the pause sound', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  h.input.queue.push(A({ start: true }));
  h.frame();
  const resets = h.input.resets;
  assert.equal(h.game.pause(), true);
  assert.equal(h.state.phase, 'paused');
  assert.equal(h.input.resets, resets + 1);
  assert.deepEqual(h.audio.played, ['pause']);
  assert.equal(h.game.pause(), false, 'already paused');
  assert.deepEqual(h.audio.played, ['pause']);
});

test('loop: game.pause() is a no-op on the title screen', () => {
  const h = loopHarness();
  h.game.start();
  h.frame();
  assert.equal(h.game.pause(), false);
  assert.equal(h.state.phase, 'title');
  assert.equal(h.input.resets, 0);
});

test('loop: coming back after game.pause() runs no catch-up burst', () => {
  const h = loopHarness({ level: 29 });
  h.game.start();
  h.frame();
  h.input.queue.push(A({ start: true }));
  h.frame();
  h.game.pause();                             // tab hidden: rAF stops firing
  const frame = h.state.frame;
  h.frame(30_000);                            // first callback after 30 s away
  assert.equal(h.state.frame, frame, 'first frame back only re-anchors the clock');
  h.frame();
  assert.equal(h.state.frame, frame + 1);
  assert.equal(h.state.phase, 'paused', 'still waiting for the player');
});

test('loop: resuming continues at normal speed', () => {
  const h = loopHarness({ level: 29 });
  h.game.start();
  h.frame();
  h.input.queue.push(A({ start: true }));
  h.frame();
  h.input.queue.push(A({ pause: true }));
  h.frame();
  for (let i = 0; i < 120; i++) h.frame();   // 2 s paused
  const y = h.state.active.y;
  h.input.queue.push(A({ pause: true }));
  h.frame();                                  // resume frame
  for (let i = 0; i < 5; i++) h.frame();
  assert.equal(h.state.active.y, y + 5, '1 row per frame, no burst');
});

// ===========================================================================
// Milestone 4
// ===========================================================================

/** Sets up a single-line clear with an I piece: row 21 open at cols 3–6. */
function primeSingle(state) {
  fillRow(state.board, 21, [3, 4, 5, 6]);
  state.active = spawnPiece('I');
}

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}

// ---------- level progression ----------

test('level: 10th line at start level 0 → level 1, levelUp event, flash starts', () => {
  const state = started();
  state.lines = 9;
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  assert.equal(state.level, 0, 'unchanged while the rows are still flashing');
  const events = finishClear(state);
  assert.equal(state.lines, 10);
  assert.equal(state.level, 1);
  assert.ok(events.includes('levelUp'));
  assert.equal(state.levelUpFlash, LEVEL_UP_FLASH_FRAMES);
});

test('level: clear points use the level before the level-up', () => {
  const state = started();
  state.lines = 9;
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  assert.equal(state.score, 40 * 1 + 2 * 20, 'level 0 value, not level 1');
});

test('level: the next piece falls at the new level speed', () => {
  const state = started();
  state.lines = 9;
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  settle(state);
  assert.equal(getGravity(state.level), 1 / 43);
  const y = state.active.y;
  run(state, 42);
  assert.equal(state.active.y, y);
  run(state, 1);
  assert.equal(state.active.y, y + 1, 'level 1: 43 frames per row');
});

test('level: every 10 lines from start 0 (20 lines → level 2)', () => {
  const state = started();
  state.lines = 19;
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  assert.equal(state.level, 2);
});

test('level: higher start levels wait for the NES first transition', () => {
  const state = started({ level: 5 });       // first level-up at 60 lines
  state.lines = 58;
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  assert.equal(state.level, 5, '59 lines');
  settle(state);
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  assert.equal(state.level, 6, '60 lines');
});

test('level: crossing a score milestone levels up on any lock, not just clears', () => {
  const state = started();
  state.score = 9_990;
  state.active = spawnPiece('T');
  state.active.y = 1;                         // hard drop 19 rows = 38 points → 10 028
  const events = run(state, 1, A({ hardDrop: true }));
  assert.equal(state.level, 1);
  assert.ok(events.includes('levelUp'));
  assert.equal(state.lines, 0);
});

test('level: no levelUp event when the level does not change', () => {
  const state = started();
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  assert.ok(!finishClear(state).includes('levelUp'));
  assert.equal(state.levelUpFlash, 0);
});

test('level: the level-up flash counts down during play and freezes while paused', () => {
  const state = started();
  state.lines = 9;
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  finishClear(state);
  run(state, 10);
  assert.equal(state.levelUpFlash, LEVEL_UP_FLASH_FRAMES - 10);
  run(state, 1, A({ pause: true }));
  run(state, 50);
  assert.equal(state.levelUpFlash, LEVEL_UP_FLASH_FRAMES - 10);
  run(state, 1, A({ pause: true }));
  run(state, 100);
  assert.equal(state.levelUpFlash, 0);
});

// ---------- start level (title screen) ----------

test('title: ←/→ choose the start level; the HUD level follows', () => {
  const state = createInitialState({ rng: seeded(1) });
  const events = run(state, 5, A({ menuX: 1 }));
  assert.equal(state.startLevel, 5);
  assert.equal(state.level, 5);
  assert.deepEqual(events, ['move', 'move', 'move', 'move', 'move']);
  run(state, 2, A({ menuX: -1 }));
  assert.equal(state.startLevel, 3);
});

test('title: start level clamps to 0..MAX_START_LEVEL without events at the ends', () => {
  const state = createInitialState({ rng: seeded(1) });
  assert.deepEqual(run(state, 3, A({ menuX: -1 })), []);
  assert.equal(state.startLevel, 0);
  run(state, 40, A({ menuX: 1 }));
  assert.equal(state.startLevel, MAX_START_LEVEL);
  assert.deepEqual(run(state, 1, A({ menuX: 1 })), []);
});

test('title: Enter starts at the chosen level with its gravity', () => {
  const state = createInitialState({ rng: seeded(1) });
  run(state, 5, A({ menuX: 1 }));
  update(state, A({ start: true }), []);
  assert.equal(state.phase, 'playing');
  assert.equal(state.level, 5);
  const y = state.active.y;
  run(state, 23);
  assert.equal(state.active.y, y + 1, 'level 5: 23 frames per row');
});

test('title: the chosen start level survives game over → title', () => {
  const state = createInitialState({ rng: seeded(1) });
  run(state, 7, A({ menuX: 1 }));
  update(state, A({ start: true }), []);
  state.board.cells[1][4] = 1;
  run(state, 1, A({ hardDrop: true }));
  settle(state);
  leaveGameOver(state);
  assert.equal(state.startLevel, 7);
  assert.equal(state.level, 7);
});

test('menuX does nothing outside the title screen', () => {
  const state = started();
  run(state, 3, A({ menuX: 1 }));
  assert.equal(state.startLevel, 0);
  assert.equal(state.level, 0);
});

// ---------- line clear phase ----------

test('line clear: rows stay on the board for LINE_CLEAR_FRAMES, then collapse', () => {
  assert.equal(LINE_CLEAR_FRAMES, 20);
  const state = started();
  primeSingle(state);
  const events = run(state, 1, A({ hardDrop: true }));
  assert.deepEqual(events, ['hardDrop', 'lock', 'clear'], 'sound cue at the start of the animation');
  assert.deepEqual(state.clearing, { rows: [21], timer: 0 });
  assert.equal(state.active, null);
  for (let i = 1; i < LINE_CLEAR_FRAMES; i++) {
    run(state, 1);
    assert.equal(state.phase, 'lineClear', `frame ${i}`);
    assert.equal(state.clearing.timer, i);
    assert.equal(filledCount(state.board), 10, 'row still present');
  }
  run(state, 1);
  assert.equal(state.phase, 'are');
  assert.equal(state.clearing, null);
  assert.equal(filledCount(state.board), 0);
});

test('line clear: next piece arrives LINE_CLEAR_FRAMES + ARE_FRAMES after the lock', () => {
  const state = started();
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  run(state, LINE_CLEAR_FRAMES + ARE_FRAMES - 1);
  assert.equal(state.active, null);
  run(state, 1);
  assert.equal(state.phase, 'playing');
  assert.ok(state.active);
});

test('line clear: records all cleared rows, including non-adjacent ones', () => {
  const state = started();
  fillRow(state.board, 19, [0]);
  fillRow(state.board, 21, [0]);
  fillRow(state.board, 20, [0, 5]);          // not completed by the I
  state.active = { type: 'I', rotation: 3, x: -1, y: 2 };
  run(state, 1, A({ hardDrop: true }));
  assert.deepEqual(state.clearing.rows, [19, 21]);
  finishClear(state);
  assert.equal(state.lines, 2);
});

test('line clear: gameplay input is ignored during the animation', () => {
  const state = started();
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  const score = state.score;
  run(state, 10, A({ hardDrop: true, hold: true, shift: 1, rotate: 1, softDrop: true }));
  assert.equal(state.phase, 'lineClear');
  assert.equal(state.score, score);
  assert.equal(state.hold.type, null);
});

test('line clear: pause freezes the animation and resumes into it', () => {
  const state = started();
  primeSingle(state);
  run(state, 1, A({ hardDrop: true }));
  run(state, 5);
  run(state, 1, A({ pause: true }));
  assert.equal(state.pausedFrom, 'lineClear');
  run(state, 100);
  assert.equal(state.clearing.timer, 5);
  run(state, 1, A({ pause: true }));
  assert.equal(state.phase, 'lineClear');
  run(state, LINE_CLEAR_FRAMES - 6);
  assert.equal(state.phase, 'lineClear');
  run(state, 1);
  assert.equal(state.phase, 'are');
});

test('line clear: tetris stats and score applied when the rows collapse', () => {
  const state = started();
  for (let y = 18; y < 22; y++) fillRow(state.board, y, [0]);
  state.active = { type: 'I', rotation: 3, x: -1, y: 2 };
  assert.ok(run(state, 1, A({ hardDrop: true })).includes('tetris'));
  assert.equal(state.stats.tetrises, 0);
  finishClear(state);
  assert.equal(state.stats.tetrises, 1);
  assert.equal(state.score, 1200 + 2 * 16);
});

// ---------- game over ----------

test('game over: Enter is ignored for GAME_OVER_DELAY_FRAMES, then returns to title', () => {
  assert.equal(GAME_OVER_DELAY_FRAMES, 60);
  const state = started();
  state.board.cells[1][4] = 1;
  run(state, 1, A({ hardDrop: true }));
  settle(state);
  assert.equal(state.phase, 'gameOver');
  run(state, GAME_OVER_DELAY_FRAMES - 1, A({ start: true }));
  assert.equal(state.phase, 'gameOver');
  assert.equal(state.gameOverTimer, GAME_OVER_DELAY_FRAMES - 1);
  run(state, 1, A({ start: true }));
  assert.equal(state.phase, 'title');
});

test('game over: newHiScore only when the previous top is beaten', () => {
  const beat = started();
  beat.hiScore = 10;
  beat.board.cells[1][4] = 1;
  run(beat, 1, A({ hardDrop: true }));       // 38 points
  settle(beat);
  assert.equal(beat.newHiScore, true);
  assert.equal(beat.hiScore, 38);

  const miss = started();
  miss.hiScore = 500;
  miss.board.cells[1][4] = 1;
  run(miss, 1, A({ hardDrop: true }));
  settle(miss);
  assert.equal(miss.newHiScore, false);
  assert.equal(miss.hiScore, 500);
});

test('game over → title: board, score, lines, stats and flags reset; top score kept', () => {
  const state = started({ level: 3 });
  state.lines = 42;
  state.board.cells[1][4] = 1;
  state.board.cells[21].fill(2);
  state.board.cells[21][0] = 0;
  run(state, 1, A({ hardDrop: true }));
  settle(state);
  const top = state.hiScore;
  leaveGameOver(state);
  assert.equal(filledCount(state.board), 0);
  assert.deepEqual([state.score, state.lines, state.level, state.stats.pieces], [0, 0, 3, 0]);
  assert.equal(state.newHiScore, false);
  assert.equal(state.gameOverTimer, 0);
  assert.equal(state.hiScore, top);
});

// ---------- high score persistence ----------

test('loadHiScore: reads a stored integer; anything else → 0', () => {
  assert.equal(HI_SCORE_KEY, 'tetris.hiScore');
  assert.equal(loadHiScore(fakeStorage({ [HI_SCORE_KEY]: '12345' })), 12345);
  for (const bad of ['', 'abc', '-5', '0', '1e999', '12abc', ' 42', '4.5', '99999999999999999999']) {
    assert.equal(loadHiScore(fakeStorage({ [HI_SCORE_KEY]: bad })), 0, JSON.stringify(bad));
  }
  assert.equal(loadHiScore(fakeStorage()), 0);
  assert.equal(loadHiScore(null), 0);
  assert.equal(loadHiScore({ getItem() { throw new Error('SecurityError'); } }), 0);
});

test('saveHiScore: writes under the key; never throws', () => {
  const storage = fakeStorage();
  assert.equal(saveHiScore(storage, 777), true);
  assert.equal(storage.data.get(HI_SCORE_KEY), '777');
  assert.equal(saveHiScore(null, 1), false);
  assert.equal(saveHiScore({ setItem() { throw new Error('QuotaExceededError'); } }, 1), false);
});

test('createGame: loads the stored top score at startup', () => {
  const h = loopHarness({ storage: fakeStorage({ [HI_SCORE_KEY]: '4321' }) });
  assert.equal(h.state.hiScore, 4321);
});

test('createGame: saves a new top score at game over; survives a "reload"', () => {
  const storage = fakeStorage({ [HI_SCORE_KEY]: '10' });
  const h = loopHarness({ storage });
  h.game.start();
  h.frame();
  h.input.queue.push(A({ start: true }));
  h.frame();
  h.state.board.cells[1][4] = 1;
  h.input.queue.push(A({ hardDrop: true }));
  for (let i = 0; i <= ARE_FRAMES; i++) h.frame();
  assert.equal(h.state.phase, 'gameOver');
  assert.ok(h.state.hiScore > 10);
  assert.equal(storage.data.get(HI_SCORE_KEY), String(h.state.hiScore));

  const reloaded = loopHarness({ storage });
  assert.equal(reloaded.state.hiScore, h.state.hiScore);
});

test('createGame: does not overwrite a better stored score', () => {
  const storage = fakeStorage({ [HI_SCORE_KEY]: '999999' });
  const h = loopHarness({ storage });
  h.game.start();
  h.frame();
  h.input.queue.push(A({ start: true }));
  h.frame();
  h.state.board.cells[1][4] = 1;
  h.input.queue.push(A({ hardDrop: true }));
  for (let i = 0; i <= ARE_FRAMES; i++) h.frame();
  assert.equal(h.state.phase, 'gameOver');
  assert.equal(storage.data.get(HI_SCORE_KEY), '999999');
});

test('createGame: works with no storage available', () => {
  const h = loopHarness({ storage: null });
  h.game.start();
  h.frame();
  assert.equal(h.state.hiScore, 0);
});
