// ==========================================================================
//  src/game.js
//  Game state, rules and the fixed-timestep loop (SPEC §6.8, §7, §8, §9).
//  update() is pure with respect to the DOM: it only mutates `state` and
//  pushes SFX names into `events`. createGame() owns the rAF loop.
// ==========================================================================

import {
  NEXT_COUNT, SOFT_DROP_G, STEP_MS, MAX_FRAME_MS, ARE_FRAMES, MAX_LOCK_RESETS, LINE_CLEAR_FRAMES,
  MAX_START_LEVEL, LEVEL_UP_FLASH_FRAMES, GAME_OVER_DELAY_FRAMES, HI_SCORE_KEY, MUTE_KEY, SOUND_KEY, START_LEVEL_KEY, BGM_KEY,
} from './config.js';
import {
  createBoard, isValidPosition, lockPiece, findFullRows, clearRows, isLockOut, dropDistance,
} from './board.js';
import { createBag, spawnPiece, getKicks } from './pieces.js';
import {
  getGravity, getLockDelay, scoreForClear, computeLevel,
  GRAVITY_EPSILON, SOFT_DROP_POINTS, HARD_DROP_POINTS,
} from './progression.js';

/** Absorbs rAF timestamp jitter (16.66 vs 16.67 ms) so 60 Hz displays get exactly 1 step per frame. */
const CLOCK_SLOP_MS = 0.5;

/** Input is reset on any phase change into or out of these (SPEC §9). */
const MENU_PHASES = new Set(['title', 'paused', 'gameOver']);

const CLEAR_STATS = [null, 'singles', 'doubles', 'triples', 'tetrises'];
const CLEAR_EVENTS = [null, 'single', 'double', 'triple', 'tetris'];   // one sound each

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
    gameOverTimer: 0,            // frames spent on the game-over screen
    softDropping: false,         // a soft drop is moving the piece (for its one-shot sound)
    newHiScore: false,           // this game beat the previous top score
  };
}

// ---------------------------------------------------------------------------
// Rules (internal helpers; all mutate state)
// ---------------------------------------------------------------------------

/** Fresh state for the same player: keeps start level, top score, RNG and frame count. */
function resetState(state) {
  const { startLevel, hiScore, rng, frame } = state;
  Object.assign(state, createInitialState({ startLevel, hiScore, rng }));
  state.frame = frame;
}

function newGame(state, events) {
  resetState(state);
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
  state.softDropping = false;
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
  const kicks = getKicks(piece.type, from, to);
  for (let i = 0; i < kicks.length; i++) {          // indexed: no iterator allocation
    piece.rotation = to;
    piece.x = x + kicks[i][0];
    piece.y = y + kicks[i][1];
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

  state.active = null;
  const rows = findFullRows(board);
  if (rows.length > 0) {
    // Rows stay on the board and flash/wipe first; they collapse when the animation ends.
    state.clearing = { rows, timer: 0 };
    state.phase = 'lineClear';
    events.push(CLEAR_EVENTS[rows.length]);
    return;
  }
  applyLevel(state, events);                      // drop points can cross a score milestone
  enterAre(state, events);
}

/** End of the line-clear animation: collapse rows, score, level, then ARE. */
function finishLineClear(state, events) {
  const cleared = clearRows(state.board, state.clearing.rows);
  state.clearing = null;
  state.score += scoreForClear(cleared, state.level);     // level before the clear
  state.lines += cleared;
  state.stats[CLEAR_STATS[cleared]]++;
  applyLevel(state, events);
  enterAre(state, events);
}

/** Entry delay before the next piece. */
function enterAre(state, events) {
  if (ARE_FRAMES > 0) {
    state.phase = 'are';
    state.areTimer = ARE_FRAMES;
  } else {
    state.phase = 'playing';
    spawnNext(state, events);
  }
}

/** Recomputes the level from lines + score (SPEC §8.2); it only ever goes up. */
function applyLevel(state, events) {
  const level = computeLevel(state);
  if (level > state.level) {
    state.level = level;
    state.levelUpFlash = LEVEL_UP_FLASH_FRAMES;
    events.push('levelUp');
  }
}

function gameOver(state, events) {
  state.phase = 'gameOver';
  state.active = null;
  state.clearing = null;
  state.gameOverTimer = 0;
  state.newHiScore = state.score > state.hiScore;
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
  if (!actions.softDrop) state.softDropping = false;
  let g = getGravity(state.level);
  if (actions.softDrop) g = Math.max(g, SOFT_DROP_G);
  state.gravityAcc += g;
  while (state.gravityAcc >= 1 - GRAVITY_EPSILON) {
    state.gravityAcc = Math.max(0, state.gravityAcc - 1);
    if (!tryMove(state, 0, 1)) {
      state.gravityAcc = 0;
      break;
    }
    if (actions.softDrop) {
      state.score += SOFT_DROP_POINTS;
      if (!state.softDropping) {                  // one cue per soft drop, not one per row
        state.softDropping = true;
        events.push('softDrop');
      }
    }
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

  if (IN_GAME_PHASES.has(state.phase)) {
    if (actions.pause) {
      pauseGame(state);
      events.push('pause');
      return;
    }
    if (state.levelUpFlash > 0) state.levelUpFlash--;
  }

  switch (state.phase) {
    case 'title':
      if (actions.menuX !== 0) selectStartLevel(state, actions.menuX, events);
      if (actions.start) newGame(state, events);
      break;
    case 'gameOver':
      state.gameOverTimer++;
      if (actions.start && state.gameOverTimer >= GAME_OVER_DELAY_FRAMES) {
        resetState(state);                        // clean board and HUD on the title screen
        state.phase = 'title';
      }
      break;
    case 'paused':
      // Nothing advances: gravity, lock delay, ARE and line clears resume exactly where they stopped.
      if (actions.pause) {
        state.phase = state.pausedFrom;
        state.pausedFrom = null;
        events.push('pause');
      }
      break;
    case 'playing':
      updatePlaying(state, actions, events);
      break;
    case 'lineClear':
      state.clearing.timer++;
      if (state.clearing.timer >= LINE_CLEAR_FRAMES) finishLineClear(state, events);
      break;
    case 'are':
      state.areTimer--;
      if (state.areTimer <= 0) {
        state.phase = 'playing';
        spawnNext(state, events);                 // may block out → gameOver
      }
      break;
  }
}

/** Title screen: ←/→ pick the start level 0..MAX_START_LEVEL (clamped). */
function selectStartLevel(state, dir, events) {
  const level = Math.min(MAX_START_LEVEL, Math.max(0, state.startLevel + dir));
  if (level === state.startLevel) return;
  state.startLevel = level;
  state.level = level;                            // HUD shows the choice
  events.push('move');
}

const IN_GAME_PHASES = new Set(['playing', 'lineClear', 'are']);

/** Pauses an in-progress game (playing, line clear or ARE). @returns {boolean} whether it paused */
export function pauseGame(state) {
  if (!IN_GAME_PHASES.has(state.phase)) return false;
  state.pausedFrom = state.phase;
  state.phase = 'paused';
  return true;
}

// ---------------------------------------------------------------------------
// Persistence: top score and settings (SPEC §8.4)
// ---------------------------------------------------------------------------

/** Non-negative integer stored under `key`, or null if missing/invalid/unavailable. */
function loadInt(storage, key) {
  try {
    const raw = storage?.getItem(key) ?? '';
    if (!/^\d+$/.test(raw)) return null;          // parseInt would accept '12abc' or '1e999'
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;                                  // e.g. storage blocked by privacy settings
  }
}

/** @returns {boolean} whether it was written */
function saveValue(storage, key, value) {
  try {
    if (!storage) return false;
    storage.setItem(key, String(value));
    return true;
  } catch {
    return false;                                 // quota / privacy mode: keep playing
  }
}

/** @returns {number} stored top score, or 0 if missing, invalid or storage is unavailable. */
export function loadHiScore(storage) {
  return loadInt(storage, HI_SCORE_KEY) ?? 0;
}

export function saveHiScore(storage, score) {
  return saveValue(storage, HI_SCORE_KEY, score);
}

/** @returns {number} last chosen start level (0..MAX_START_LEVEL), default 0 */
export function loadStartLevel(storage) {
  const level = loadInt(storage, START_LEVEL_KEY);
  return level !== null && level <= MAX_START_LEVEL ? level : 0;
}

export { SOUND_KEY };

/**
 * @returns {boolean} stored sound setting; cleanly evaluates to true when null or undefined.
 */
export function loadSoundEnabled(storage) {
  try {
    const rawSound = storage?.getItem?.(SOUND_KEY);
    if (rawSound !== null && rawSound !== undefined) {
      return rawSound !== '0' && rawSound !== 'false';
    }
    const rawMute = storage?.getItem?.(MUTE_KEY);
    if (rawMute !== null && rawMute !== undefined) {
      return rawMute !== '1';
    }
    return true; // Default cleanly evaluates to true when null or undefined
  } catch {
    return true;
  }
}

/** @returns {boolean} stored mute setting, default false */
export function loadMuted(storage) {
  return !loadSoundEnabled(storage);
}

/** @returns {boolean} stored music preference; on unless explicitly turned off; cleanly evaluates to true when null or undefined */
export function loadBgmEnabled(storage) {
  try {
    const raw = storage?.getItem?.(BGM_KEY);
    if (raw === null || raw === undefined) return true;
    return raw !== '0' && raw !== 'false';
  } catch {
    return true;
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
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
  if (clock.last === null) {                      // first frame / after stop() or pause()
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
 * @returns {{ start(): void, stop(): void, pause(): boolean, toggleMute(): boolean,
 *             toggleMusic(): boolean, getState(): object }}
 */
export function createGame({
  input,
  renderer,
  ui,
  audio,
  initialState = createInitialState(),
  storage = defaultStorage(),
  onError = (where, err) => console.error(`[tetris] ${where} error (the game keeps running):`, err),
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
}) {
  const state = initialState;
  state.hiScore = Math.max(state.hiScore, loadHiScore(storage));
  const reported = new Map();                    // where → last message, so errors log once
  function report(where, err) {
    const message = String(err?.message ?? err);
    if (reported.get(where) === message) return;
    reported.set(where, message);
    try { onError(where, err); } catch { /* a broken logger must not break the loop */ }
  }

  const muted = loadMuted(storage);
  const musicOn = loadBgmEnabled(storage);
  try {
    audio.setMuted?.(muted);
    audio.setMusicEnabled?.(musicOn);
  } catch (err) {
    report('audio', err);
  }
  ui.setMuted?.(muted);
  ui.setMusic?.(musicOn);

  function toggleMute() {
    let now = false;
    try {
      now = audio.toggleMute ? audio.toggleMute() : false;
      ui.setMuted?.(now);
    } catch (err) {
      report('audio', err);
    }
    saveValue(storage, MUTE_KEY, now ? 1 : 0);
    saveValue(storage, SOUND_KEY, now ? 0 : 1);
    return now;
  }

  function toggleMusic() {
    let on = false;
    try {
      on = audio.toggleMusic ? audio.toggleMusic() : false;
      ui.setMusic?.(on);
    } catch (err) {
      report('audio', err);
    }
    saveValue(storage, BGM_KEY, on ? 1 : 0);
    return on;
  }
  const clock = createClock();
  const events = [];
  let running = false;
  let rafId = 0;

  /**
   * The loop must survive anything a subsystem throws. Before this, a single
   * Web Audio exception on the title → play frame aborted frame() before it
   * rendered or rescheduled itself: the state was 'playing' but the screen stayed
   * frozen on "PRESS ENTER". Now every frame reschedules in `finally`, and audio,
   * rendering and UI fail independently (reported once each, not 60×/s).
   */
  function frame(now) {
    try {
      runFrame(now);
    } catch (err) {
      report('frame', err);
    } finally {
      if (running) rafId = raf(frame);
    }
  }

  function runFrame(now) {
    const steps = advanceClock(clock, now);
    for (let i = 0; i < steps; i++) {
      const prevPhase = state.phase;
      while (events.length > 0) events.pop();     // not length = 0: that frees the backing store
      const actions = input.poll();
      if (actions.mute) toggleMute();            // settings, not game state: work in every phase
      if (actions.music) toggleMusic();

      const hasAction =
        actions.start ||
        actions.shift !== 0 ||
        actions.rotate !== 0 ||
        actions.softDrop ||
        actions.hardDrop ||
        actions.hold ||
        actions.pause;

      if (hasAction) {
        const audioCtx = audio.context ?? audio.ctx;
        if (audioCtx && audioCtx.state === 'suspended') {
          try { audioCtx.resume?.(); } catch { /* ignore */ }
        } else if (typeof audio.resume === 'function' && audio.state === 'suspended') {
          try { audio.resume(); } catch { /* ignore */ }
        }
      }

      update(state, actions, events);
      try {
        for (let e = 0; e < events.length; e++) audio.play(events[e]);
      } catch (err) {
        report('audio', err);                    // silence, never a stuck game
      }
      if (state.phase !== prevPhase && touchesMenu(prevPhase, state.phase)) input.reset();
      if (state.phase === 'gameOver' && prevPhase !== 'gameOver' && state.newHiScore) {
        saveHiScore(storage, state.hiScore);
      }
      if (prevPhase === 'title' && state.phase === 'playing') {
        saveValue(storage, START_LEVEL_KEY, state.startLevel);
        const audioCtx = audio.context ?? audio.ctx;
        if (audioCtx && audioCtx.state === 'suspended') {
          try { audioCtx.resume?.(); } catch { /* ignore */ }
        } else if (typeof audio.resume === 'function' && audio.state === 'suspended') {
          try { audio.resume(); } catch { /* ignore */ }
        }
        try {
          audio.restartMusic?.();                 // every new game starts at bar 1
        } catch (err) {
          report('audio', err);
        }
      }
    }
    // Music plays only while a game is in play; pause / title / game over stop it
    // (it resumes from the same beat). tick() keeps a measure scheduled ahead.
    try {
      audio.setMusicActive?.(IN_GAME_PHASES.has(state.phase));
      audio.tick?.();
    } catch (err) {
      report('audio', err);
    }
    try {
      renderer.render(state);
    } catch (err) {
      report('render', err);
    }
    try {
      ui.update(state);
    } catch (err) {
      report('ui', err);
    }
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
      try {
        audio.play('pause');
        audio.setMusicActive?.(false);           // hidden tabs get no more frames: stop now
      } catch (err) {
        report('audio', err);
      }
      input.reset();
      clock.last = null;
      return true;
    },
    /** Same as pressing M / B (HUD buttons). @returns {boolean} the new state */
    toggleMute,
    toggleMusic,
    getState: () => state,
  };
}
