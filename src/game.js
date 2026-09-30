// ==========================================================================
//  src/game.js
//  Game state, rules and the fixed-timestep loop (SPEC §6.8, §7, §8, §9).
//  update() is pure with respect to the DOM: it only mutates `state` and
//  pushes SFX names into `events`. createGame() owns the rAF loop.
// ==========================================================================

import {
  NEXT_COUNT, SOFT_DROP_G, STEP_MS, MAX_FRAME_MS, ARE_FRAMES, MAX_LOCK_RESETS,
} from './config.js';
import {
  createBoard, isValidPosition, lockPiece, findFullRows, clearRows, isLockOut, dropDistance,
} from './board.js';
import { createBag, spawnPiece, getKicks } from './pieces.js';
import {
  getGravity, getLockDelay, scoreForClear, GRAVITY_EPSILON, SOFT_DROP_POINTS, HARD_DROP_POINTS,
} from './progression.js';

/** Absorbs rAF timestamp jitter (16.66 vs 16.67 ms) so 60 Hz displays get exactly 1 step per frame. */
const CLOCK_SLOP_MS = 0.5;

/** Input is reset on any phase change into or out of these (SPEC §9). */
const MENU_PHASES = new Set(['title', 'paused', 'gameOver']);

const CLEAR_STATS = [null, 'singles', 'doubles', 'triples', 'tetrises'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @returns {object} the full SPEC §7 state, in the 'title' phase. */
export function createInitialState({ startLevel = 0, hiScore = 0, rng = Math.random } = {}) {
  const bag = createBag(rng);
  return {
    phase: 'title',
    pausedFrom: null,
    frame: 0,

    board: createBoard(),
    active: null,
    rng,
    bag,
    queue: bag.peek(NEXT_COUNT),
    hold: { type: null, used: false },

    gravityAcc: 0,
    lock: { timer: 0, resets: 0, lowestY: 0 },
    clearing: null,
    areTimer: 0,

    startLevel,
    level: startLevel,
    lines: 0,
    score: 0,
    hiScore,
    stats: { pieces: 0, singles: 0, doubles: 0, triples: 0, tetrises: 0 },
    levelUpFlash: 0,
  };
}

// ---------------------------------------------------------------------------
// Rules (internal helpers; all mutate state)
// ---------------------------------------------------------------------------

function newGame(state, events) {
  const { startLevel, hiScore, rng, frame } = state;
  Object.assign(state, createInitialState({ startLevel, hiScore, rng }));
  state.frame = frame;
  state.phase = 'playing';
  spawnNext(state, events);
}

/** Deals the next bag piece and advances the preview queue. */
function spawnNext(state, events) {
  const type = state.bag.next();
  state.queue = state.bag.peek(NEXT_COUNT);
  spawnType(state, type, events);
}

/** Places a fresh piece of `type` at the spawn position; false on block out. */
function spawnType(state, type, events) {
  state.active = spawnPiece(type);
  state.gravityAcc = 0;
  if (!isValidPosition(state.board, state.active)) {
    gameOver(state, events);                      // block out
    return false;
  }
  tryMove(state, 0, 1);                           // drop into view if free (SPEC §8.4)
  const { lock } = state;
  lock.timer = 0;
  lock.resets = 0;
  lock.lowestY = state.active.y;
  return true;
}

/** Hold once per piece: park the active type, bring back the held one (or the next in queue). */
function tryHold(state, events) {
  const { hold } = state;
  if (hold.used) return false;
  const current = state.active.type;
  hold.used = true;
  events.push('hold');
  if (hold.type === null) {
    hold.type = current;
    spawnNext(state, events);
  } else {
    const swapped = hold.type;
    hold.type = current;
    spawnType(state, swapped, events);
  }
  return true;
}

function isGrounded(state) {
  const piece = state.active;
  piece.y++;
  const blocked = !isValidPosition(state.board, piece);
  piece.y--;
  return blocked;
}

/** Move-reset: a successful move/rotate while the lock timer runs restarts it, up to the cap. */
function onManipulated(state) {
  const { lock } = state;
  if (lock.timer > 0 && lock.resets < MAX_LOCK_RESETS) {
    lock.timer = 0;
    lock.resets++;
  }
}

/** Moves the active piece if the target is free. Mutates in place, no allocation. */
function tryMove(state, dx, dy) {
  const piece = state.active;
  piece.x += dx;
  piece.y += dy;
  if (isValidPosition(state.board, piece)) return true;
  piece.x -= dx;
  piece.y -= dy;
  return false;
}

/** SRS rotation: first kick offset that fits wins (SPEC §8.5). */
function tryRotate(state, dir) {
  const piece = state.active;
  const { rotation: from, x, y } = piece;
  const to = (from + dir + 4) % 4;
  for (const [kx, ky] of getKicks(piece.type, from, to)) {
    piece.rotation = to;
    piece.x = x + kx;
    piece.y = y + ky;
    if (isValidPosition(state.board, piece)) return true;
  }
  piece.rotation = from;
  piece.x = x;
  piece.y = y;
  return false;
}

function lockAndAdvance(state, events) {
  const { board, active } = state;
  lockPiece(board, active);
  events.push('lock');
  state.stats.pieces++;
  state.hold.used = false;

  if (isLockOut(active)) {
    gameOver(state, events);
    return;
  }

  const rows = findFullRows(board);
  if (rows.length > 0) {
    const cleared = clearRows(board, rows);
    state.score += scoreForClear(cleared, state.level);   // level before the clear
    state.lines += cleared;
    state.stats[CLEAR_STATS[cleared]]++;
    events.push(cleared === 4 ? 'tetris' : 'clear');
  }

  // Entry delay before the next piece (M4 inserts the line-clear animation first).
  state.active = null;
  if (ARE_FRAMES > 0) {
    state.phase = 'are';
    state.areTimer = ARE_FRAMES;
  } else {
    spawnNext(state, events);
  }
}

function gameOver(state, events) {
  state.phase = 'gameOver';
  state.active = null;
  state.hiScore = Math.max(state.hiScore, state.score);
  events.push('gameOver');
}

function updatePlaying(state, actions, events) {
  const { lock } = state;

  if (actions.hold) {
    tryHold(state, events);
    if (state.phase !== 'playing') return;        // block out on the swapped-in piece
  }

  if (actions.rotate !== 0 && tryRotate(state, actions.rotate)) {
    events.push('rotate');
    onManipulated(state);
  }

  if (actions.shiftToWall) {
    let moved = false;
    while (tryMove(state, actions.shift, 0)) moved = true;
    if (moved) {
      events.push('move');
      onManipulated(state);
    }
  } else if (actions.shift !== 0 && tryMove(state, actions.shift, 0)) {
    events.push('move');
    onManipulated(state);
  }

  if (actions.hardDrop) {
    const distance = dropDistance(state.board, state.active);
    state.active.y += distance;
    state.score += distance * HARD_DROP_POINTS;
    events.push('hardDrop');
    lockAndAdvance(state, events);
    return;
  }

  // Gravity
  let g = getGravity(state.level);
  if (actions.softDrop) g = Math.max(g, SOFT_DROP_G);
  state.gravityAcc += g;
  while (state.gravityAcc >= 1 - GRAVITY_EPSILON) {
    state.gravityAcc = Math.max(0, state.gravityAcc - 1);
    if (!tryMove(state, 0, 1)) {
      state.gravityAcc = 0;
      break;
    }
    if (actions.softDrop) state.score += SOFT_DROP_POINTS;
    if (state.active.y > lock.lowestY) {          // new lowest row restores the reset budget
      lock.lowestY = state.active.y;
      lock.resets = 0;
      lock.timer = 0;
    }
  }

  // Lock delay (SPEC §8.1)
  if (isGrounded(state)) {
    lock.timer++;
    if (lock.timer >= getLockDelay(state.level)) lockAndAdvance(state, events);
  } else {
    lock.timer = 0;
  }
}

/**
 * One 60 Hz simulation step (SPEC §9.1).
 * @param {object} state
 * @param {import('./input.js').Actions} actions
 * @param {string[]} events SFX names are pushed here
 */
export function update(state, actions, events) {
  state.frame++;
  switch (state.phase) {
    case 'title':
      if (actions.start) newGame(state, events);
      break;
    case 'gameOver':
      if (actions.start) state.phase = 'title';
      break;
    case 'paused':
      // Nothing advances: gravity, lock delay and ARE resume exactly where they stopped.
      if (actions.pause) {
        state.phase = state.pausedFrom;
        state.pausedFrom = null;
        events.push('pause');
      }
      break;
    case 'playing':
      if (actions.pause) {
        pauseGame(state);
        events.push('pause');
        break;
      }
      updatePlaying(state, actions, events);
      break;
    case 'are':
      if (actions.pause) {
        pauseGame(state);
        events.push('pause');
        break;
      }
      state.areTimer--;
      if (state.areTimer <= 0) {
        state.phase = 'playing';
        spawnNext(state, events);                 // may block out → gameOver
      }
      break;
  }
}

/** Pauses an in-progress game (playing or ARE). @returns {boolean} whether it paused */
export function pauseGame(state) {
  if (state.phase !== 'playing' && state.phase !== 'are') return false;
  state.pausedFrom = state.phase;
  state.phase = 'paused';
  return true;
}

// ---------------------------------------------------------------------------
// Fixed-timestep clock (SPEC §9)
// ---------------------------------------------------------------------------

/** @returns {{ last: number | null, acc: number }} */
export function createClock() {
  return { last: null, acc: 0 };
}

/**
 * Feeds one rAF timestamp into the clock.
 * @returns {number} simulation steps to run this frame
 */
export function advanceClock(clock, nowMs, stepMs = STEP_MS, maxFrameMs = MAX_FRAME_MS) {
  if (clock.last === null) {                      // first frame / after stop()
    clock.last = nowMs;
    return 0;
  }
  const dt = Math.min(Math.max(0, nowMs - clock.last), maxFrameMs);
  clock.last = nowMs;
  clock.acc += dt;
  const steps = Math.floor((clock.acc + CLOCK_SLOP_MS) / stepMs);
  clock.acc -= steps * stepMs;                    // may dip up to CLOCK_SLOP_MS below 0
  return steps;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function touchesMenu(from, to) {
  return MENU_PHASES.has(from) || MENU_PHASES.has(to);
}

/**
 * @returns {{ start(): void, stop(): void, pause(): boolean, getState(): object }}
 */
export function createGame({
  input,
  renderer,
  ui,
  audio,
  initialState = createInitialState(),
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
}) {
  const state = initialState;
  const clock = createClock();
  const events = [];
  let running = false;
  let rafId = 0;

  function frame(now) {
    const steps = advanceClock(clock, now);
    for (let i = 0; i < steps; i++) {
      const prevPhase = state.phase;
      events.length = 0;
      update(state, input.poll(), events);
      for (const e of events) audio.play(e);
      if (state.phase !== prevPhase && touchesMenu(prevPhase, state.phase)) input.reset();
    }
    renderer.render(state);
    ui.update(state);
    if (running) rafId = raf(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      rafId = raf(frame);
    },
    stop() {
      if (!running) return;
      running = false;
      caf(rafId);
      clock.last = null;
    },
    /**
     * External pause (tab hidden / window blur). Browsers stop rAF in hidden
     * tabs, so the clock is re-anchored: the first frame back runs no catch-up
     * steps. No-op outside playing / ARE.
     */
    pause() {
      if (!pauseGame(state)) return false;
      audio.play('pause');
      input.reset();
      clock.last = null;
      return true;
    },
    getState: () => state,
  };
}
