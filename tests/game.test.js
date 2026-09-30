import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState, update, createClock, advanceClock, createGame,
} from '../src/game.js';
import { emptyActions } from '../src/input.js';
import { spawnPiece, getAbsoluteCells, TYPE_INDEX, PIECE_TYPES } from '../src/pieces.js';
import { STEP_MS, NEXT_COUNT } from '../src/config.js';

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
    'active', 'areTimer', 'bag', 'board', 'clearing', 'frame', 'gravityAcc', 'hiScore', 'hold',
    'level', 'levelUpFlash', 'lines', 'lock', 'pausedFrom', 'phase', 'queue', 'rng', 'score',
    'startLevel', 'stats',
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
  assert.equal(a.active.type, expectedNext);
  assert.equal(a.queue.length, NEXT_COUNT);
});

test('gameOver: waits for start → title → start gives a fresh board, same settings', () => {
  const state = started({ level: 4, seed: 2 });
  state.board.cells[1][4] = 1;                 // guarantees block out on next spawn
  state.hiScore = 999;
  run(state, 1, A({ hardDrop: true }));
  assert.equal(state.phase, 'gameOver');

  run(state, 10);
  assert.equal(state.phase, 'gameOver');
  update(state, A({ start: true }), []);
  assert.equal(state.phase, 'title');
  update(state, A({ start: true }), []);
  assert.equal(state.phase, 'playing');
  assert.equal(filledCount(state.board), 0);
  assert.equal(state.lines, 0);
  assert.equal(state.stats.pieces, 0);
  assert.equal(state.level, 4);
  assert.equal(state.hiScore, 999);
});

// ---------- gravity physics ----------

test('gravity: levels 0–29 step exactly every framesPerRow frames down the whole well, then lock', () => {
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
      assert.ok(frame <= 21 * f, `level ${level} never locked`);
    }
    // T falls from y=1 to y=20 (19 rows), and the failed 20th step locks it.
    assert.deepEqual(moves, Array.from({ length: 19 }, (_, i) => (i + 1) * f), `level ${level} row timing`);
    assert.equal(frame, 20 * f, `level ${level} lock frame`);
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

test('gravity: level 99 (20 G) lands and locks on the first frame', () => {
  const state = started({ level: 99 });
  const first = state.active.type;
  const events = run(state, 1);
  assert.equal(state.stats.pieces, 1);
  assert.ok(events.includes('lock'));
  assert.equal(filledCount(state.board), 4);
  assert.ok(state.board.cells[21].some((v) => v === TYPE_INDEX[first]));
  assert.equal(state.active.y, 1, 'next piece spawned');
});

test('gravity: accumulator resets for each new piece', () => {
  const state = started({ level: 0 });
  run(state, 30);                              // acc = 30/48
  run(state, 1, A({ hardDrop: true }));
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

test('soft drop locks the piece when it reaches the floor (no lock delay in M2)', () => {
  const state = started({ level: 0 });
  state.active = { type: 'T', rotation: 0, x: 3, y: 18 };
  run(state, 4, A({ softDrop: true }));        // 2 frames → y 19, 2 frames → y 20
  assert.equal(state.stats.pieces, 0);
  run(state, 2, A({ softDrop: true }));        // failed step → lock
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

test('hard drop from spawn: locks T at the floor and spawns the next piece', () => {
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
  assert.equal(state.phase, 'playing');
  assert.equal(state.active.y, 0);
});

test('block out: next spawn overlaps the stack → gameOver', () => {
  const state = started();
  state.board.cells[1][4] = 1;               // every spawn shape covers (4, 1)
  state.active = { type: 'T', rotation: 0, x: 0, y: 10 };
  const events = run(state, 1, A({ hardDrop: true }));
  assert.equal(state.phase, 'gameOver');
  assert.equal(state.active, null);
  assert.deepEqual(events, ['hardDrop', 'lock', 'gameOver']);
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

test('lock out via gravity as well as hard drop', () => {
  const state = started({ level: 29 });
  for (let x = 3; x <= 5; x++) state.board.cells[2][x] = 1;
  state.active = spawnPiece('T');
  run(state, 1);
  assert.equal(state.phase, 'gameOver');
});

test('no lock out when part of the piece is visible', () => {
  const state = started();
  for (let x = 0; x <= 2; x++) state.board.cells[3][x] = 1;
  state.active = { type: 'T', rotation: 0, x: 0, y: 1 };   // rows 1–2, row 2 visible
  run(state, 1, A({ hardDrop: true }));
  assert.equal(state.phase, 'playing');
  assert.equal(state.stats.pieces, 1);
});

test('gameOver ignores gameplay input', () => {
  const state = started();
  state.board.cells[1][4] = 1;
  run(state, 1, A({ hardDrop: true }));
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

function loopHarness({ level = 0 } = {}) {
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

  h.input.queue.push(A({ hardDrop: true }), A({ hardDrop: true }));
  h.frame();
  h.frame();
  assert.equal(h.state.stats.pieces, 2);
  assert.equal(h.input.resets, 1, 'locking pieces keeps DAS charge');

  h.state.board.cells[1][4] = 1;
  h.input.queue.push(A({ hardDrop: true }));
  h.frame();
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
