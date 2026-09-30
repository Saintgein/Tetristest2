// Allocation check for the per-frame hot path (SPEC §11). Runs the real game
// loop (createGame: input → update → audio → render → ui) with no-op canvases,
// so only our code is measured. Steady-state gameplay frames must not allocate; the only expected
// cost is formatting a HUD number when it actually changes (the DOM needs a string).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createInput } from '../src/input.js';
import { createInitialState, update, createGame } from '../src/game.js';
import { createRenderer } from '../src/renderer.js';
import { createUI } from '../src/ui.js';
import { createAudio, BGM } from '../src/audio.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

function noopCanvas(width, height) {
  const ctx = {
    fillStyle: '', globalAlpha: 1, imageSmoothingEnabled: false,
    fillRect() {}, clearRect() {}, drawImage() {},
  };
  return { width, height, getContext: () => ctx };
}

const noopElement = () => ({ textContent: '', hidden: false, classList: { toggle() {} } });

/**
 * Web Audio stand-in that does nothing and allocates nothing, so the real music
 * sequencer can be measured. Like the real API, every method lives once on a
 * prototype (e.g. one AudioParam.prototype.setValueAtTime): per-instance
 * closures would make the sequencer's call sites megamorphic, and V8 would then
 * box every fractional argument, a cost of the fake rather than the code.
 */
const audioCounters = { notes: 0, paramCalls: 0 };
class NoopParam {
  constructor() { this.value = 0; }
  setValueAtTime() { audioCounters.paramCalls++; }
  linearRampToValueAtTime() { audioCounters.paramCalls++; }
  setTargetAtTime() { audioCounters.paramCalls++; }
  cancelScheduledValues() {}
}
class NoopFrequencyParam extends NoopParam {
  setValueAtTime() { audioCounters.notes++; }   // one frequency set per scheduled note
}
class NoopNode {
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}
class NoopGain extends NoopNode { constructor() { super(); this.gain = new NoopParam(); } }
class NoopOscillator extends NoopNode {
  constructor() { super(); this.frequency = new NoopFrequencyParam(); }
  setPeriodicWave() {}
}
class NoopBufferSource extends NoopNode { constructor() { super(); this.playbackRate = new NoopParam(); this.buffer = null; } }
class NoopAudioContext {
  constructor() {
    // Integer seconds: a fractional store into this field can box a HeapNumber in the
    // harness itself (measured), which would be blamed on the code under test.
    this.state = 'running';
    this.currentTime = 10;
    this.sampleRate = 48_000;
    this.destination = new NoopNode();
    NoopAudioContext.last = this;
  }
  resume() { return Promise.resolve(); }
  createGain() { return new NoopGain(); }
  createOscillator() { return new NoopOscillator(); }
  createBufferSource() { return new NoopBufferSource(); }
  createBuffer(channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
  createPeriodicWave() { return {}; }
}

/** @returns {{ NoopAudioContext, counter }} counter.notes / counter.ctx track the latest context */
function noopAudioContextClass() {
  const counter = {
    get notes() { return audioCounters.notes; },
    get ctx() { return NoopAudioContext.last; },
  };
  return { NoopAudioContext, counter };
}

/** Real music engine; effect playback stubbed (it legitimately creates nodes). */
function realMusic() {
  const { NoopAudioContext, counter } = noopAudioContextClass();
  const real = createAudio({ AudioContext: NoopAudioContext });
  real.unlock();
  const audio = {
    play() {}, setMuted() {}, toggleMute() { return false; },
    setMusicEnabled: (on) => real.setMusicEnabled(on),
    toggleMusic: () => real.toggleMusic(),
    setMusicActive: (on) => real.setMusicActive(on),
    restartMusic: () => real.restartMusic(),
    tick: () => real.tick(),
  };
  return { audio, real, counter, ctx: counter.ctx };
}

function setup({ softDrop = false } = {}) {
  const listeners = {};
  const input = createInput({ addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener() {} });
  const renderer = createRenderer(
    { boardCanvas: noopCanvas(160, 320), holdCanvas: noopCanvas(80, 48), nextCanvas: noopCanvas(80, 144) },
    { createCanvas: noopCanvas },
  );
  const ui = createUI({
    score: noopElement(), hiScore: noopElement(), level: noopElement(), lines: noopElement(),
    overlay: noopElement(), overlayTitle: noopElement(), overlaySub: noopElement(),
    overlayInfo: noopElement(), well: noopElement(),
  });
  const state = createInitialState({ startLevel: 0, rng: () => 0.42 });
  update(state, { ...input.poll(), start: true }, []);

  // Drive the real createGame loop (poll → update → audio → render → ui) with a
  // fake rAF that doesn't allocate: one pending callback, a numeric clock.
  let pending = null;
  // Integer-ms timestamps (17, 17, 16 = 50 ms per 3 frames, exactly 60 Hz) held in an
  // object field: V8 keeps them unboxed, so the harness itself allocates nothing.
  // (A double in a closure variable would box a 16-byte HeapNumber every frame.)
  const clock = { now: 1000 };
  const DELTAS = [17, 17, 16];
  const music = realMusic();
  const { audio } = music;
  const game = createGame({
    input, renderer, ui, audio, storage: null, initialState: state,
    raf(cb) { pending = cb; return 1; },
    caf() { pending = null; },
  });
  game.start();
  pending(clock.now);                         // first frame only anchors the clock

  // Pre-built key events so the harness itself doesn't allocate in the loop
  const key = (code) => ({ code, repeat: false, preventDefault() {} });
  const keys = { left: key('ArrowLeft'), right: key('ArrowRight'), up: key('ArrowUp'), z: key('KeyZ'), s: key('KeyS') };
  let scoreChanges = 0;

  function frame(i) {
    // DAS both ways, rotation taps both ways, and optionally soft drop
    const phase = i % 240;
    if (phase === 0) listeners.keydown(keys.left);
    if (phase === 60) listeners.keyup(keys.left);
    if (phase === 80) listeners.keydown(keys.right);
    if (phase === 140) listeners.keyup(keys.right);
    if (phase === 150) { listeners.keydown(keys.up); listeners.keyup(keys.up); }
    if (phase === 160) { listeners.keydown(keys.z); listeners.keyup(keys.z); }
    if (softDrop && phase === 170) listeners.keydown(keys.s);
    if (softDrop && phase === 200) listeners.keyup(keys.s);

    const score = state.score;
    clock.now += DELTAS[i % 3];
    if (i % 60 === 0) music.ctx.currentTime += 1;   // audio clock: +1 s per 60 frames (stays an integer)
    pending(clock.now);                       // exactly one simulation step per frame
    if (state.score !== score) scoreChanges++;

    // Keep the piece airborne so the run stays in steady state (no lock/spawn)
    if (state.active.y > 12) state.active.y = 2;
  }

  return { state, frame, scoreChanges: () => scoreChanges, music };
}

function measure(frames, run) {
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < frames; i++) run(i);
  return process.memoryUsage().heapUsed - before;
}

const WARMUP = 20_000;
const FRAMES = 20_000;

test('steady-state gameplay frames do not allocate (DAS, rotation, gravity, render, HUD, music)', () => {
  const h = setup();
  for (let i = 0; i < WARMUP; i++) h.frame(i);     // let JIT and inline caches settle
  const notesBefore = h.music.counter.notes;
  // Each measurement carries a fixed ~20 KB overhead (GC bookkeeping) regardless of
  // length, so compare N and 2N frames: the difference is the true per-frame cost.
  let frame = WARMUP;
  const run = () => h.frame(frame++);
  const short = measure(FRAMES, run);
  const long = measure(2 * FRAMES, run);
  const perFrame = (long - short) / FRAMES;
  console.log(`# steady state: heap +${short} B over ${FRAMES} frames, +${long} B over ${2 * FRAMES} (marginal ${perFrame.toFixed(3)} B/frame)`);
  assert.equal(h.state.phase, 'playing');
  assert.equal(h.state.stats.pieces, 0, 'no locks during the run');
  assert.equal(h.music.real.musicPlaying, true, 'background music was running');
  const notes = h.music.counter.notes - notesBefore;
  // 60 000 frames ≈ 1000 s ≈ 24 loops of the 41 s song; 3 voices × ~237 notes per loop
  assert.ok(notes > 3000, 'music scheduled ' + notes + ' notes during the run');
  // Growth must not scale with frame count. One small object per frame would add
  // ≥ 16 B/frame (≥ 320 KB between the two runs); only the fixed overhead is allowed.
  assert.ok(Math.abs(perFrame) < 0.75, `${perFrame.toFixed(3)} bytes/frame allocated`);
  // No absolute bound here: right after the forced gc(), V8 re-allocates flushed code and
  // feedback once (a constant ~20–250 KB depending on how much code runs). That constant
  // cancels out in the N vs 2N difference above, which is the real criterion.
});

test('a HUD number change costs only its formatted strings', () => {
  const h = setup({ softDrop: true });
  for (let i = 0; i < WARMUP; i++) h.frame(i);
  const changesBefore = h.scoreChanges();
  const bytes = measure(FRAMES, (i) => h.frame(i));
  const changes = h.scoreChanges() - changesBefore;
  const perChange = bytes / changes;
  console.log(`# soft drop: ${changes} score changes, ${bytes} bytes (${perChange.toFixed(0)} B per change)`);
  assert.ok(changes > 1000);
  // SCORE and TOP each get one short string per change; nothing else allocates.
  assert.ok(perChange < 256, `${perChange.toFixed(0)} bytes per score change`);
});

test('probe sanity: the harness detects a 1-object-per-frame leak', () => {
  const h = setup();
  for (let i = 0; i < 5_000; i++) h.frame(i);
  const sink = [];
  const bytes = measure(5_000, (i) => { h.frame(i); sink.push({ i }); });
  assert.ok(bytes / 5_000 >= 16, `leak detector saw only ${bytes} bytes`);
  assert.equal(sink.length, 5_000);
});


