import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAudio, RECIPES, SFX_NAMES, CHANNELS, DUTY_STEPS, TRIANGLE_STEPS,
  stepWaveCoefficients, lfsrSequence, noteFreq,
} from '../src/audio.js';

// ---------- fake Web Audio ----------

function fakeParam(value = 0) {
  const events = [];
  return {
    value,
    events,
    setValueAtTime(v, t) { events.push(['set', v, t]); },
    linearRampToValueAtTime(v, t) { events.push(['ramp', v, t]); },
    setTargetAtTime(v, t, c) { events.push(['target', v, t, c]); this.value = v; },
    cancelScheduledValues(t) { events.push(['cancel', t]); },
  };
}

function createFakeContextClass() {
  const instances = [];
  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 10;
      this.sampleRate = 48_000;
      this.destination = { kind: 'destination' };
      this.nodes = [];
      this.resumes = 0;
      instances.push(this);
    }
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
    node(kind, extra) {
      const n = {
        kind, connectedTo: null, started: null, stopped: [],
        connect(dest) { this.connectedTo = dest; return dest; },
        disconnect() { this.connectedTo = null; },
        start(t) { this.started = t; },
        stop(t) { this.stopped.push(t); },
        ...extra,
      };
      this.nodes.push(n);
      return n;
    }
    createGain() { return this.node('gain', { gain: fakeParam(1) }); }
    createOscillator() {
      return this.node('osc', { frequency: fakeParam(440), wave: null, setPeriodicWave(w) { this.wave = w; } });
    }
    createBufferSource() { return this.node('noise', { buffer: null, loop: false, playbackRate: fakeParam(1) }); }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { channels, length, rate, getChannelData: () => data };
    }
    createPeriodicWave(real, imag) { return { real, imag }; }
  }
  return { FakeAudioContext, instances };
}

function unlocked(options = {}) {
  const { FakeAudioContext, instances } = createFakeContextClass();
  const audio = createAudio({ AudioContext: FakeAudioContext, ...options });
  audio.unlock();
  return { audio, ctx: instances[0], instances };
}

const sources = (ctx) => ctx.nodes.filter((n) => n.kind === 'osc' || n.kind === 'noise');

// ---------- waveforms ----------

/** Samples a Fourier series at `count` points over one period. */
function synthesize({ real, imag }, count = 2048) {
  const out = [];
  for (let s = 0; s < count; s++) {
    const t = (2 * Math.PI * (s + 0.5)) / count;
    let v = 0;
    for (let n = 1; n < real.length; n++) v += real[n] * Math.cos(n * t) + imag[n] * Math.sin(n * t);
    out.push(v);
  }
  return out;
}

test('duty sequences: 12.5 / 25 / 50 / 75 % of the 8 steps are high', () => {
  for (const [duty, steps] of Object.entries(DUTY_STEPS)) {
    assert.equal(steps.length, 8);
    assert.equal(steps.filter((v) => v > 0).length / 8, Number(duty));
  }
});

test('pulse waves: the synthesized wave is high for the duty fraction of the period', () => {
  for (const [duty, steps] of Object.entries(DUTY_STEPS)) {
    const coeffs = stepWaveCoefficients(steps, 64);
    const wave = synthesize(coeffs);
    const mean = (2 * Number(duty)) - 1;         // DC is dropped, so compare around the mean
    const high = wave.filter((v) => v > -mean).length / wave.length;
    assert.ok(Math.abs(high - Number(duty)) < 0.03, `duty ${duty}: high ${high.toFixed(3)}`);
  }
});

test('50% duty is a square wave: only odd harmonics', () => {
  const { real, imag } = stepWaveCoefficients(DUTY_STEPS[0.5], 16);
  for (let n = 2; n <= 16; n += 2) {
    assert.ok(Math.abs(real[n]) < 1e-6 && Math.abs(imag[n]) < 1e-6, `harmonic ${n}`);
  }
  const amp = (n) => Math.hypot(real[n], imag[n]);
  assert.ok(Math.abs(amp(3) / amp(1) - 1 / 3) < 0.02, 'square: 3rd harmonic ≈ 1/3');
});

test('triangle: 32-step 4-bit staircase, spectrum close to an ideal triangle', () => {
  assert.equal(TRIANGLE_STEPS.length, 32);
  assert.equal(new Set(TRIANGLE_STEPS).size, 16, '16 distinct levels (4-bit)');
  assert.equal(Math.max(...TRIANGLE_STEPS), 1);
  assert.equal(Math.min(...TRIANGLE_STEPS), -1);
  const { real, imag } = stepWaveCoefficients(TRIANGLE_STEPS, 16);
  const amp = (n) => Math.hypot(real[n], imag[n]);
  assert.ok(Math.abs(amp(3) / amp(1) - 1 / 9) < 0.02, 'triangle: 3rd harmonic ≈ 1/9');
  assert.ok(amp(2) < 1e-6, 'no even harmonics');
});

test('noise LFSR: long mode repeats every 32767 clocks, short mode every 93', () => {
  const long = lfsrSequence('long', 32767 * 2);
  for (let i = 0; i < 32767; i += 97) assert.equal(long[i], long[i + 32767]);
  assert.notDeepEqual([...long.slice(0, 93)], [...long.slice(93, 186)], 'long mode is not the 93-step loop');

  const short = lfsrSequence('short', 93 * 3);
  for (let i = 0; i < 93 * 2; i++) assert.equal(short[i], short[i + 93]);
  for (const p of [1, 3, 31]) assert.notDeepEqual([...short.slice(0, p)], [...short.slice(p, 2 * p)], `not period ${p}`);
});

test('noise LFSR: ±1 samples, roughly balanced', () => {
  const seq = lfsrSequence('long', 32767);
  assert.ok([...seq].every((v) => v === 1 || v === -1));
  const high = seq.filter((v) => v > 0).length;
  assert.ok(Math.abs(high - 16384) <= 1, `high ${high}`);
});

test('noteFreq: A4 = 440 Hz, octaves double', () => {
  assert.equal(noteFreq(69), 440);
  assert.equal(noteFreq(81), 880);
  assert.ok(Math.abs(noteFreq(60) - 261.63) < 0.01);
});

// ---------- recipes ----------

test('every game event has a recipe on valid channels', () => {
  assert.deepEqual(SFX_NAMES.sort(), [
    'double', 'gameOver', 'hardDrop', 'hold', 'levelUp', 'lock', 'move', 'pause', 'rotate',
    'single', 'softDrop', 'tetris', 'triple',
  ]);
  for (const name of SFX_NAMES) {
    for (const n of RECIPES[name]) {
      assert.ok(CHANNELS.includes(n.ch), `${name}: channel ${n.ch}`);
      assert.ok(n.dur > 0 && n.at >= 0 && n.vol > 0 && n.vol <= 1, `${name}: timing/volume`);
      if (n.ch === 'noise') assert.ok(n.rate > 0 && ['long', 'short'].includes(n.mode), `${name}: noise`);
      else assert.ok(Number.isFinite(n.note), `${name}: note`);
      if (n.duty !== undefined && n.ch !== 'triangle') assert.ok(n.duty in DUTY_STEPS, `${name}: duty ${n.duty}`);
    }
  }
});

test('clears escalate: single < double < triple < tetris; each sounds different', () => {
  const length = (name) => Math.max(...RECIPES[name].map((n) => n.at + n.dur));
  assert.ok(length('single') < length('double'));
  assert.ok(length('double') < length('triple'));
  assert.ok(length('triple') < length('tetris'));
  const tetrisChannels = new Set(RECIPES.tetris.map((n) => n.ch));
  assert.deepEqual([...tetrisChannels].sort(), ['noise', 'pulse1', 'pulse2', 'triangle'], 'fanfare uses all 4 channels');
  const shapes = SFX_NAMES.map((name) => JSON.stringify(RECIPES[name]));
  assert.equal(new Set(shapes).size, SFX_NAMES.length, 'no two effects are identical');
});

test('effects stay short enough not to overlap gameplay (game over ≤ 1.5 s, the rest < 1 s)', () => {
  for (const name of SFX_NAMES) {
    const end = Math.max(...RECIPES[name].map((n) => n.at + n.dur));
    assert.ok(end <= (name === 'gameOver' ? 1.5 : 1), `${name}: ${end}s`);
  }
});

// ---------- engine ----------

test('no Web Audio: every method is a safe no-op', () => {
  const audio = createAudio({ AudioContext: undefined });
  audio.unlock();
  for (const name of SFX_NAMES) audio.play(name);
  audio.setMuted(true);
  assert.equal(audio.muted, true);
  assert.equal(audio.toggleMute(), false);
  audio.setVolume(0.3);
  assert.equal(audio.ready, false);
});

test('locked: play() before unlock() creates nothing (autoplay policy)', () => {
  const { FakeAudioContext, instances } = createFakeContextClass();
  const audio = createAudio({ AudioContext: FakeAudioContext });
  audio.play('move');
  assert.equal(instances.length, 0);
  assert.equal(audio.ready, false);
});

test('unlock: creates one context and resumes it; repeat calls only resume if suspended', () => {
  const { audio, ctx, instances } = unlocked();
  assert.equal(instances.length, 1);
  assert.equal(ctx.resumes, 1);
  audio.unlock();
  assert.equal(instances.length, 1);
  assert.equal(ctx.resumes, 1, 'running: no extra resume');
  ctx.state = 'suspended';                       // e.g. mobile browser suspended it
  audio.unlock();
  assert.equal(ctx.resumes, 2);
});

test('unlock: a constructor that throws leaves audio silent, not broken', () => {
  const audio = createAudio({ AudioContext: class { constructor() { throw new Error('NotAllowedError'); } } });
  audio.unlock();
  audio.play('move');
  assert.equal(audio.ready, false);
});

test('graph: 4 channel gains → master → destination', () => {
  const { ctx } = unlocked();
  const gains = ctx.nodes.filter((n) => n.kind === 'gain');
  const master = gains.find((g) => g.connectedTo === ctx.destination);
  assert.ok(master);
  assert.equal(gains.filter((g) => g.connectedTo === master).length, 4);
});

test('play: one source per note, at the right time, pitch and waveform', () => {
  const { audio, ctx } = unlocked();
  audio.play('rotate');
  const [first, second] = sources(ctx);
  assert.equal(sources(ctx).length, RECIPES.rotate.length);
  assert.equal(first.started, 10);
  assert.ok(Math.abs(second.started - (10 + RECIPES.rotate[1].at)) < 1e-9);
  assert.deepEqual(first.frequency.events[0], ['set', noteFreq(79), 10]);
  assert.ok(first.wave && first.wave.real instanceof Float32Array, 'pulse uses a PeriodicWave');
  assert.ok(first.stopped.length === 1 && first.stopped[0] > first.started);
});

test('play: noise uses a looping LFSR buffer at the requested clock rate', () => {
  const { audio, ctx } = unlocked();
  audio.play('softDrop');
  const [n] = sources(ctx);
  assert.equal(n.kind, 'noise');
  assert.equal(n.loop, true);
  assert.equal(n.buffer.length, 93, 'short-mode loop');
  assert.deepEqual(n.playbackRate.events[0], ['set', RECIPES.softDrop[0].rate / 48_000, 10]);
});

test('play: note envelopes decay to silence at the end of each note', () => {
  const { audio, ctx } = unlocked();
  audio.play('move');
  const env = ctx.nodes.find((n) => n.kind === 'gain' && n.gain.events.length > 0);
  const last = env.gain.events.at(-1);
  assert.deepEqual(last.slice(0, 2), ['ramp', 0]);
  assert.ok(Math.abs(last[2] - (10 + RECIPES.move[0].dur)) < 1e-9);
});

test('channel stealing: a new sound on a channel cuts the previous one there', () => {
  const { audio, ctx } = unlocked();
  audio.play('move');                            // pulse1
  const moveSource = sources(ctx)[0];
  ctx.currentTime = 10.01;
  audio.play('rotate');                          // pulse1 again
  assert.ok(moveSource.stopped.includes(10.01), 'cut at the new start time');
});

test('channel stealing: sounds on other channels keep playing', () => {
  const { audio, ctx } = unlocked();
  audio.play('move');                            // pulse1
  const moveSource = sources(ctx)[0];
  audio.play('lock');                            // noise + triangle
  assert.equal(moveSource.stopped.length, 1, 'only its own scheduled stop');
});

test('mute / volume: master gain follows; toggleMute returns the new state', () => {
  const { audio, ctx } = unlocked({ volume: 0.5 });
  const master = ctx.nodes.find((n) => n.kind === 'gain' && n.connectedTo === ctx.destination);
  assert.equal(master.gain.value, 0.5);
  assert.equal(audio.toggleMute(), true);
  assert.equal(master.gain.value, 0);
  assert.equal(audio.toggleMute(), false);
  assert.equal(master.gain.value, 0.5);
  audio.setVolume(2);
  assert.equal(master.gain.value, 1, 'clamped');
  audio.setVolume(-1);
  assert.equal(master.gain.value, 0);
});

test('starting muted: the context is created silent', () => {
  const { ctx } = unlocked({ muted: true });
  const master = ctx.nodes.find((n) => n.kind === 'gain' && n.connectedTo === ctx.destination);
  assert.equal(master.gain.value, 0);
});

test('unknown effect names are ignored', () => {
  const { audio, ctx } = unlocked();
  const before = ctx.nodes.length;
  audio.play('explode');
  assert.equal(ctx.nodes.length, before);
});

test('every recipe plays without throwing and schedules one source per note', () => {
  const { audio, ctx } = unlocked();
  for (const name of SFX_NAMES) {
    const before = sources(ctx).length;
    audio.play(name);
    assert.equal(sources(ctx).length - before, RECIPES[name].length, name);
  }
});
