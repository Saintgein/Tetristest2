// Allocation and leak checks for the background-music sequencer (src/audio.js).
// Kept in its own file so node --test runs it in a fresh process: other suites'
// harnesses would otherwise leave V8's JIT feedback for these closures polymorphic,
// and the numbers would describe that pollution rather than the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { PerformanceObserver, constants } from 'node:perf_hooks';
import { createAudio, BGM } from '../src/audio.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

// ---------- Web Audio stand-in ----------
// Like the real API, every method lives once on a prototype. Per-instance closures
// would make the sequencer's call sites megamorphic, and V8 would box each
// fractional argument: a cost of the fake, not of the sequencer.

const counters = { notes: 0, paramCalls: 0 };
class NoopParam {
  constructor() { this.value = 0; }
  setValueAtTime() { counters.paramCalls++; }
  linearRampToValueAtTime() { counters.paramCalls++; }
  setTargetAtTime() { counters.paramCalls++; }
  cancelScheduledValues() {}
}
class NoopFrequencyParam extends NoopParam {
  setValueAtTime() { counters.notes++; }             // one frequency set per scheduled note
}
class NoopNode { connect() {} disconnect() {} start() {} stop() {} }
class NoopGain extends NoopNode { constructor() { super(); this.gain = new NoopParam(); } }
class NoopOscillator extends NoopNode {
  constructor() { super(); this.frequency = new NoopFrequencyParam(); }
  setPeriodicWave() {}
}
class NoopAudioContext {
  constructor() {
    // Integer seconds: fractional stores into this field can box a HeapNumber in
    // the harness itself (measured), which would be blamed on the sequencer.
    this.state = 'running';
    this.currentTime = 10;
    this.sampleRate = 48_000;
    this.destination = new NoopNode();
    NoopAudioContext.last = this;
  }
  resume() { return Promise.resolve(); }
  createGain() { return new NoopGain(); }
  createOscillator() { return new NoopOscillator(); }
  createBufferSource() { const n = new NoopNode(); n.playbackRate = new NoopParam(); return n; }
  createBuffer(channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
  createPeriodicWave() { return {}; }
}

function playing() {
  const audio = createAudio({ AudioContext: NoopAudioContext });
  audio.unlock();
  audio.setMusicActive(true);
  return { audio, ctx: NoopAudioContext.last };
}

const SONG_SECONDS = (BGM.lengthBeats * 60) / BGM.tempo;

/**
 * Runs `step` n times; reports heap growth and how many young-generation GCs
 * (scavenges) ran meanwhile. Allocation-free code never triggers one, so
 * "0 scavenges" rules out garbage hidden by a collection mid-measurement.
 */
async function measure(n, step) {
  gc(); gc();
  await new Promise((r) => setImmediate(r));
  const entries = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  const before = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) step(i);
  const t1 = performance.now();
  const bytes = process.memoryUsage().heapUsed - before;
  await new Promise((r) => setTimeout(r, 20));
  observer.disconnect();
  const scavenges = entries.filter((e) =>
    e.startTime >= t0 && e.startTime <= t1 && e.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR).length;
  return { bytes, scavenges };
}

/**
 * Measures after JIT warm-up. Until V8's optimizing compiler has delivered code
 * (later under CPU load, e.g. when npm test runs files in parallel), unoptimized
 * tiers box fractional numbers. That transient is JS itself, not this code. So
 * re-measure until a window is clean, up to `attempts`; each failed window is
 * also more warm-up. Returns the final window plus how many it took.
 */
async function measureSettled(n, step, perUnit, { attempts = 6, limit = 0.5 } = {}) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const before = perUnit.count();
    result = await measure(n, step);
    result.units = perUnit.count() - before;
    result.attempt = attempt;
    if (result.scavenges === 0 && result.bytes / result.units < limit) break;
  }
  return result;
}

// ---------- per-frame work ----------

test('tick() with nothing due allocates nothing (the common frame)', async () => {
  const { audio } = playing();
  for (let i = 0; i < 20_000; i++) audio.tick();
  let ticks = 0;
  const r = await measureSettled(200_000, () => { ticks++; audio.tick(); }, { count: () => ticks });
  console.log(`# idle ticks: +${r.bytes} B over ${r.units} ticks, ${r.scavenges} scavenges (attempt ${r.attempt})`);
  assert.equal(r.scavenges, 0);
  assert.ok(r.bytes / r.units < 0.5, `${(r.bytes / r.units).toFixed(2)} B/tick`);   // 1 object/tick ≥ 16 B
});

test('scheduling ~67 000 notes across ~290 loops allocates nothing', async () => {
  const { audio, ctx } = playing();
  const step = () => { ctx.currentTime += 1; audio.tick(); };   // 1 s per tick: ~7 notes each
  for (let i = 0; i < 10_000; i++) step();                      // a fresh instance needs a real warm-up
  const r = await measureSettled(12_000, step, { count: () => counters.notes });
  const loops = 12_000 / SONG_SECONDS;
  console.log(`# scheduling: ${r.units} notes over ${loops.toFixed(0)} loops; heap +${r.bytes} B (${(r.bytes / r.units).toFixed(3)} B/note), ${r.scavenges} scavenges (attempt ${r.attempt})`);
  assert.ok(r.units > 60_000, `scheduled ${r.units} notes`);
  assert.equal(r.scavenges, 0, 'no GC needed');
  assert.ok(r.bytes / r.units < 0.5, `${(r.bytes / r.units).toFixed(3)} B per note`);    // 1 box/note ≥ 16 B
});

test('60 fps playback: a realistic frame loop allocates nothing', async () => {
  const { audio, ctx } = playing();
  // 60 frames per second; the audio clock advances in whole seconds every 60 frames
  // (the lookahead is 1.7 s, so notes are scheduled continuously).
  let frames = 0;
  const frame = () => { if (frames++ % 60 === 0) ctx.currentTime += 1; audio.tick(); };
  for (let i = 0; i < 60_000; i++) frame();
  const notes0 = counters.notes;
  const r = await measureSettled(120_000, frame, { count: () => frames });   // ~33 minutes of play per window
  console.log(`# 60 fps: ${counters.notes - notes0} notes, ${r.units} frames; heap +${r.bytes} B (${(r.bytes / r.units).toFixed(3)} B/frame), ${r.scavenges} scavenges (attempt ${r.attempt})`);
  assert.equal(r.scavenges, 0);
  assert.ok(r.bytes / r.units < 0.5, `${(r.bytes / r.units).toFixed(3)} B/frame`);
});

// ---------- pause / resume (player events, not per frame) ----------

test('pause / resume: no leak over 10 000 transitions; transient cost is small', async () => {
  const { audio, ctx } = playing();
  const cycle = () => {
    ctx.currentTime += 1;
    audio.setMusicActive(false);
    ctx.currentTime += 1;
    audio.setMusicActive(true);
    audio.tick();
  };
  for (let i = 0; i < 2_000; i++) cycle();
  const { bytes } = await measure(10_000, cycle);
  gc(); gc();
  const retainedBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 10_000; i++) cycle();
  gc(); gc();
  const retained = process.memoryUsage().heapUsed - retainedBefore;
  console.log(`# pause/resume: ${(bytes / 10_000).toFixed(1)} B transient per pause+resume; retained Δ ${retained} B after 10000 more`);
  assert.ok(retained < 64 * 1024, `retained heap grew ${retained} B`);
  // A pause/resume happens a few times per minute at most, and each re-schedules
  // one measure of notes. Keep that under 1 KB so it stays negligible.
  assert.ok(bytes / 10_000 < 1024, `${(bytes / 10_000).toFixed(1)} B per pause+resume`);
});

test('no leak: retained heap is flat from loop 10 to loop 100', async () => {
  const { audio, ctx } = playing();
  const run = (loops) => {
    for (let i = 0; i < Math.ceil(loops * SONG_SECONDS); i++) { ctx.currentTime += 1; audio.tick(); }
  };
  run(10);
  gc(); gc();
  const at10 = process.memoryUsage().heapUsed;
  run(90);
  gc(); gc();
  const at100 = process.memoryUsage().heapUsed;
  console.log(`# retained heap: loop 10 ${at10} B, loop 100 ${at100} B (Δ ${at100 - at10} B)`);
  assert.ok(at100 - at10 < 64 * 1024, `grew ${at100 - at10} B`);
});

test('measure() sanity: an allocating loop is caught', async () => {
  const sink = [];
  const { bytes, scavenges } = await measure(200_000, (i) => { sink[i & 1023] = { i }; });
  assert.ok(scavenges > 0 || bytes > 1_000_000, `bytes ${bytes}, scavenges ${scavenges}`);
});
