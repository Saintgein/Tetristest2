import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAudio, RECIPES, SFX_NAMES, CHANNELS, DUTY_STEPS, TRIANGLE_STEPS,
  stepWaveCoefficients, lfsrSequence, noteFreq, BGM, MUSIC_LOOKAHEAD_S, parseNote, compileVoice,
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
  const ctx = instances[0];
  if (ctx) ctx.builtAtUnlock = ctx.nodes.length;   // channel buses + persistent music voices
  return { audio, ctx, instances };
}

/** Sources created by effects (skips the persistent music oscillators built at unlock). */
const sources = (ctx) => ctx.nodes.slice(ctx.builtAtUnlock ?? 0).filter((n) => n.kind === 'osc' || n.kind === 'noise');

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

test('graph: 4 effect channel buses + 1 music bus → master → destination', () => {
  const { ctx } = unlocked();
  const gains = ctx.nodes.filter((n) => n.kind === 'gain');
  const master = gains.find((g) => g.connectedTo === ctx.destination);
  assert.ok(master);
  assert.equal(gains.filter((g) => g.connectedTo === master).length, 5);
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
  const env = ctx.nodes.slice(ctx.builtAtUnlock).find((n) => n.kind === 'gain' && n.gain.events.length > 0);
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

// ===========================================================================
// Background music
// ===========================================================================

const SPB = 60 / BGM.tempo;
const START_DELAY = 0.05;

/** The 3 persistent music voices built at unlock: { osc, env, duck } in BGM voice order. */
function musicVoices(ctx) {
  return ctx.nodes.slice(0, ctx.builtAtUnlock)
    .filter((n) => n.kind === 'osc')
    .map((osc) => ({ osc, env: osc.connectedTo, duck: osc.connectedTo.connectedTo }));
}

/** [time, freq] of every note scheduled on a voice (frequency set events). */
const noteEvents = (voice) => voice.osc.frequency.events.filter((e) => e[0] === 'set').map((e) => [e[2], e[1]]);

/** Every sounding note of a voice over `loops` passes, as expected [time, freq] from an anchor. */
function expectedNotes(data, anchor, fromBeat, untilTime, loops = 4) {
  const out = [];
  for (let loop = 0; loop < loops; loop++) {
    for (let i = 0; i < data.starts.length; i++) {
      const start = loop * BGM.lengthBeats + data.starts[i];
      const t = anchor + (start - fromBeat) * SPB;
      if (start < fromBeat || data.freqs[i] === 0 || t >= untilTime) continue;
      out.push([t, data.freqs[i]]);
    }
  }
  return out;
}

function playingMusic(options) {
  const h = unlocked(options);
  h.audio.setMusicActive(true);
  return { ...h, voices: musicVoices(h.ctx) };
}

// ---------- composition ----------

test('BGM: Korobeiniki in A minor, 140 BPM, 24 bars, 3 voices on pulse 1 / pulse 2 / triangle', () => {
  assert.equal(BGM.tempo, 140);
  assert.equal(BGM.lengthBeats, 96);
  assert.deepEqual(BGM.voices.map((v) => [v.name, v.channel]), [['lead', 'pulse1'], ['harmony', 'pulse2'], ['bass', 'triangle']]);
  assert.ok([0.25, 0.5].includes(BGM.voices[0].duty), 'lead duty 25 % or 50 %');
  const opening = [...BGM.voices[0].midi.slice(0, 6)].map((m) => m);
  assert.deepEqual(opening, ['E5', 'B4', 'C5', 'D5', 'C5', 'B4'].map(parseNote), 'the famous opening phrase');
});

test('BGM: every voice fills the loop exactly — contiguous notes, no gaps or overlaps', () => {
  for (const v of BGM.voices) {
    assert.equal(v.beats, BGM.lengthBeats, v.name);
    assert.equal(v.starts[0], 0);
    for (let i = 1; i < v.starts.length; i++) {
      assert.ok(Math.abs(v.starts[i] - (v.starts[i - 1] + v.durs[i - 1])) < 1e-9, `${v.name} note ${i}`);
    }
    assert.equal(v.starts.at(-1) + v.durs.at(-1), BGM.lengthBeats);
  }
});

test('BGM: all pitches in A minor (natural + harmonic: G and G#); voices in sensible ranges', () => {
  const allowed = new Set([9, 11, 0, 2, 4, 5, 7, 8]);   // A B C D E F G G#
  const [lead, harmony, bass] = BGM.voices;
  for (const v of BGM.voices) {
    for (const m of v.midi) if (m >= 0) assert.ok(allowed.has(m % 12), `${v.name}: MIDI ${m}`);
  }
  const range = (v) => { const ms = [...v.midi].filter((m) => m >= 0); return [Math.min(...ms), Math.max(...ms)]; };
  assert.ok(range(lead)[0] >= parseNote('G#4') && range(lead)[1] <= parseNote('A5'), `lead ${range(lead)}`);
  assert.ok(range(harmony)[1] < range(lead)[1], 'harmony sits under the lead');
  assert.ok(range(bass)[1] <= parseNote('A3'), `bass ${range(bass)}`);
  assert.ok([...bass.durs].every((d) => d === 1), 'walking bass: one note per beat');
});

test('compileVoice: rejects a bar that is not 4 beats; parseNote handles sharps and flats', () => {
  assert.throws(() => compileVoice(['C4:1 D4:1 E4:1']), /bar 1 has 3 beats/);
  assert.equal(parseNote('A4'), 69);
  assert.equal(parseNote('G#4'), 68);
  assert.equal(parseNote('Bb3'), 58);
  assert.throws(() => parseNote('H2'));
});

// ---------- sequencer ----------

test('music: silent until unlocked AND the game is in play AND enabled', () => {
  const { FakeAudioContext, instances } = createFakeContextClass();
  const audio = createAudio({ AudioContext: FakeAudioContext });
  audio.setMusicActive(true);
  audio.tick();
  assert.equal(audio.musicPlaying, false, 'locked');
  audio.unlock();
  assert.equal(audio.musicPlaying, true, 'starts as soon as the context exists');
  assert.equal(instances.length, 1);

  const idle = unlocked();
  idle.audio.tick();
  assert.equal(idle.audio.musicPlaying, false, 'not in play yet');
  assert.equal(noteEvents(musicVoices(idle.ctx)[0]).length, 0);

  const off = unlocked({ musicEnabled: false });
  off.audio.setMusicActive(true);
  assert.equal(off.audio.musicPlaying, false, 'disabled by preference');
});

test('music: starts at bar 1 — first lead note E5 right after the start delay', () => {
  const { voices } = playingMusic();
  const [first] = noteEvents(voices[0]);
  assert.ok(Math.abs(first[0] - (10 + START_DELAY)) < 1e-9);
  assert.equal(first[1], noteFreq(parseNote('E5')));
});

test('music: schedules exactly one measure ahead — no more, no less', () => {
  const { voices } = playingMusic();
  const horizon = 10 + MUSIC_LOOKAHEAD_S;
  assert.ok(Math.abs(MUSIC_LOOKAHEAD_S - 4 * SPB) < 1e-12, 'lookahead = one 4/4 measure');
  BGM.voices.forEach((data, k) => {
    assert.deepEqual(noteEvents(voices[k]), expectedNotes(data, 10 + START_DELAY, 0, horizon), data.name);
  });
});

test('music: every note scheduled exactly once, on time, across 3 loops with irregular ticks', () => {
  const { audio, ctx, voices } = playingMusic();
  const seconds = 3 * BGM.lengthBeats * SPB + 1;
  const rnd = mulberry(99);
  while (ctx.currentTime < 10 + seconds) {
    ctx.currentTime += 0.004 + rnd() * 0.25;    // 4 ms … 254 ms between frames
    audio.tick();
  }
  const horizon = ctx.currentTime + MUSIC_LOOKAHEAD_S;
  BGM.voices.forEach((data, k) => {
    const got = noteEvents(voices[k]);
    const want = expectedNotes(data, 10 + START_DELAY, 0, horizon);
    assert.equal(got.length, want.length, `${data.name}: note count`);
    got.forEach(([t, f], i) => {
      assert.equal(f, want[i][1], `${data.name} #${i} pitch`);
      assert.ok(Math.abs(t - want[i][0]) < 1e-9, `${data.name} #${i} time drifted by ${t - want[i][0]}`);
    });
  });
});

test('music: the loop is seamless — loop 2 starts exactly one song-length after loop 1', () => {
  const { audio, ctx, voices } = playingMusic();
  const loop = BGM.lengthBeats * SPB;
  while (ctx.currentTime < 10 + loop + 1) { ctx.currentTime += 1 / 60; audio.tick(); }
  const lead = noteEvents(voices[0]);
  const perLoop = [...BGM.voices[0].freqs].filter((f) => f > 0).length;
  const firstOfLoop2 = lead[perLoop];
  assert.ok(Math.abs(firstOfLoop2[0] - (lead[0][0] + loop)) < 1e-9);
  assert.equal(firstOfLoop2[1], lead[0][1]);
});

test('music: note envelopes rise and fall within each gated note', () => {
  const { voices } = playingMusic();
  const g = voices[0].env.gain.events;
  assert.deepEqual(g.slice(0, 2).map((e) => e.slice(0, 2)), [['set', 0], ['ramp', 1]]);
  const firstEnd = 10 + START_DELAY + BGM.voices[0].durs[0] * BGM.voices[0].gate * SPB;
  assert.ok(Math.abs(g[3][2] - firstEnd) < 1e-9, 'released at the gate, before the next note');
  assert.deepEqual(g[3].slice(0, 2), ['ramp', 0]);
});

test('pause: stops the voices and remembers the exact beat; ticks while paused schedule nothing', () => {
  const { audio, ctx, voices } = playingMusic();
  const pauseBeat = 5.25;                               // inside the A4 eighth at beat 5–5.5
  ctx.currentTime = 10 + START_DELAY + pauseBeat * SPB;
  audio.tick();
  const before = noteEvents(voices[0]).length;
  audio.setMusicActive(false);
  assert.equal(audio.musicPlaying, false);
  assert.ok(Math.abs(audio.musicBeat - pauseBeat) < 1e-9);
  for (const v of voices) {
    assert.ok(v.env.gain.events.some((e) => e[0] === 'cancel' && e[1] === ctx.currentTime), 'future notes cancelled');
    assert.deepEqual(v.env.gain.events.at(-1).slice(0, 2), ['target', 0], 'fades out, no click');
  }
  for (let i = 0; i < 300; i++) { ctx.currentTime += 1 / 60; audio.tick(); }
  assert.equal(noteEvents(voices[0]).length, before, 'nothing scheduled while paused');
});

test('resume: continues from the paused beat — finishes the interrupted note, nothing skipped', () => {
  const { audio, ctx, voices } = playingMusic();
  const pauseBeat = 5.25;
  ctx.currentTime = 10 + START_DELAY + pauseBeat * SPB;
  audio.tick();
  audio.setMusicActive(false);
  const before = noteEvents(voices[0]).length;
  ctx.currentTime += 7.5;                               // paused for 7.5 s
  audio.setMusicActive(true);
  const resumed = noteEvents(voices[0]).slice(before);
  const anchor = ctx.currentTime + START_DELAY;
  assert.deepEqual(resumed[0], [anchor, noteFreq(parseNote('A4'))], 'rest of the A4 plays first');
  assert.ok(Math.abs(resumed[1][0] - (anchor + 0.25 * SPB)) < 1e-9, 'then C5 at beat 5.5, on time');
  assert.equal(resumed[1][1], noteFreq(parseNote('C5')));
  // Everything after the finished note follows the song, shifted by exactly the pause
  const want = expectedNotes(BGM.voices[0], anchor, pauseBeat, ctx.currentTime + MUSIC_LOOKAHEAD_S);
  assert.equal(resumed.length - 1, want.length);
  want.forEach(([t, f], i) => {
    assert.equal(resumed[i + 1][1], f, `note ${i} pitch`);
    assert.ok(Math.abs(resumed[i + 1][0] - t) < 1e-9, `note ${i} time`);
  });
});

test('resume: pausing across the loop end continues into loop 2 without a restart', () => {
  const { audio, ctx } = playingMusic();
  const beat = BGM.lengthBeats - 0.5;                   // last half-beat of the song
  while (ctx.currentTime < 10 + START_DELAY + beat * SPB) { ctx.currentTime += 1 / 60; audio.tick(); }
  audio.setMusicActive(false);
  const paused = audio.musicBeat;
  ctx.currentTime += 3;
  audio.setMusicActive(true);
  ctx.currentTime += SPB;
  assert.ok(audio.musicBeat > BGM.lengthBeats, `position ${audio.musicBeat} carried on past the loop point from ${paused}`);
});

test('restartMusic: a new game starts from bar 1', () => {
  const { audio, ctx, voices } = playingMusic();
  ctx.currentTime += 20;
  audio.tick();
  audio.restartMusic();
  assert.equal(audio.musicPlaying, true);
  const last = noteEvents(voices[0]);
  const restartIndex = last.findIndex(([t]) => Math.abs(t - (ctx.currentTime + START_DELAY)) < 1e-9);
  assert.ok(restartIndex >= 0, 'a note right at the restart');
  assert.equal(last[restartIndex][1], noteFreq(parseNote('E5')));
  assert.ok(audio.musicBeat < 0.01);
});

test('music toggle: off pauses in place, on resumes the same beat; toggleMusic returns the state', () => {
  const { audio, ctx } = playingMusic();
  ctx.currentTime = 10 + START_DELAY + 12 * SPB;
  audio.tick();
  assert.equal(audio.toggleMusic(), false);
  assert.equal(audio.musicPlaying, false);
  const beat = audio.musicBeat;
  ctx.currentTime += 5;
  assert.equal(audio.toggleMusic(), true);
  assert.equal(audio.musicPlaying, true);
  assert.ok(Math.abs(audio.musicBeat - beat) < 1e-9, 'no jump while it was off');
  assert.equal(audio.musicEnabled, true);
});

test('setMusicActive is idempotent: repeated calls neither restart nor re-anchor', () => {
  const { audio, ctx, voices } = playingMusic();
  ctx.currentTime += 1;
  for (let i = 0; i < 10; i++) audio.setMusicActive(true);
  audio.tick();
  const leadTimes = noteEvents(voices[0]).map(([t]) => t);
  assert.equal(new Set(leadTimes).size, leadTimes.length, 'no note scheduled twice');
});

// ---------- effects take precedence over music ----------

test('ducking: an effect on pulse 1 silences the lead for exactly its length; other voices keep playing', () => {
  const { audio, ctx, voices } = playingMusic();
  ctx.currentTime = 11;
  audio.play('move');                                   // pulse 1, 30 ms
  const [lead, harmony, bass] = voices;
  assert.deepEqual(lead.duck.gain.events.slice(-2).map((e) => e.slice(0, 3)), [['set', 0, 11], ['set', 1, 11 + RECIPES.move[0].dur]]);
  assert.equal(harmony.duck.gain.events.length, 0);
  assert.equal(bass.duck.gain.events.length, 0);
});

test('ducking: triangle effects (lock) duck the bass only; noise-only effects duck nothing', () => {
  const { audio, voices } = playingMusic();
  audio.play('lock');                                   // noise + triangle
  assert.equal(voices[0].duck.gain.events.length, 0);
  assert.ok(voices[2].duck.gain.events.some((e) => e[0] === 'set' && e[1] === 0));
  const fresh = playingMusic();
  fresh.audio.play('softDrop');                         // noise only
  assert.ok(fresh.voices.every((v) => v.duck.gain.events.length === 0));
});

test('ducking: the sequencer keeps scheduling underneath — music comes back on the beat', () => {
  const { audio, ctx, voices } = playingMusic();
  const before = noteEvents(voices[0]).length;
  audio.play('tetris');                                 // 0.7 s on every channel
  for (let i = 0; i < 180; i++) { ctx.currentTime += 1 / 60; audio.tick(); }
  const lead = noteEvents(voices[0]);
  assert.ok(lead.length > before, 'notes kept coming while ducked');
  assert.deepEqual(lead, expectedNotes(BGM.voices[0], 10 + START_DELAY, 0, ctx.currentTime + MUSIC_LOOKAHEAD_S));
});

test('master mute silences music too (music bus feeds the master gain)', () => {
  const { audio, ctx } = playingMusic({ volume: 0.5 });
  const master = ctx.nodes.find((n) => n.kind === 'gain' && n.connectedTo === ctx.destination);
  const musicBus = ctx.nodes.find((n) => n.kind === 'gain' && n.connectedTo === master && musicVoices(ctx).some((v) => v.duck.connectedTo?.connectedTo === n));
  assert.ok(musicBus, 'music bus → master');
  audio.setMuted(true);
  assert.equal(master.gain.value, 0);
  assert.equal(audio.musicPlaying, true, 'mute is volume, not transport: the song keeps its place');
});

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// Autoplay / AudioContext guard
// ===========================================================================

function contextClassWith(patch) {
  const { FakeAudioContext, instances } = createFakeContextClass();
  class Patched extends FakeAudioContext {}
  Object.assign(Patched.prototype, patch);
  return { Patched, instances };
}

test('unlock: resume() returning no promise (old WebKit) keeps the context — no leak across gestures', () => {
  const { Patched, instances } = contextClassWith({ resume() { this.resumes++; return undefined; } });
  const audio = createAudio({ AudioContext: Patched });
  for (let i = 0; i < 6; i++) audio.unlock();
  assert.equal(instances.length, 1, 'one context, not one per keypress');
  assert.equal(audio.ready, true);
});

test('unlock: resume() rejecting (strict autoplay) is swallowed; the context stays usable', async () => {
  const { Patched, instances } = contextClassWith({ resume() { return Promise.reject(new Error('NotAllowedError')); } });
  const audio = createAudio({ AudioContext: Patched });
  audio.unlock();
  await new Promise((r) => setTimeout(r, 10));   // an unhandled rejection would fail this test
  assert.equal(audio.ready, true);
  audio.unlock();
  assert.equal(instances.length, 1);
  audio.play('move');                            // effects still schedule (they play once allowed)
});

test('unlock: resume() throwing synchronously keeps the context', () => {
  const { Patched, instances } = contextClassWith({ resume() { throw new Error('InvalidStateError'); } });
  const audio = createAudio({ AudioContext: Patched });
  audio.unlock();
  audio.unlock();
  assert.equal(audio.ready, true);
  assert.equal(instances.length, 1);
});

test('unlock: graph setup failing after construction closes that context and retries cleanly', () => {
  const closed = [];
  let failures = 1;
  const { Patched, instances } = contextClassWith({
    close() { closed.push(this); return Promise.resolve(); },
    createPeriodicWave(real, imag) {
      if (failures-- > 0) throw new Error('unsupported');
      return { real, imag };
    },
  });
  const audio = createAudio({ AudioContext: Patched });
  audio.unlock();
  assert.equal(audio.ready, false);
  assert.deepEqual(closed, [instances[0]], 'the half-built context was closed');
  audio.unlock();
  assert.equal(audio.ready, true, 'the next gesture succeeds');
  assert.equal(instances.length, 2);
});

test('music: a Web Audio exception switches music off for the session instead of throwing', () => {
  const { Patched, instances } = contextClassWith({});
  const audio = createAudio({ AudioContext: Patched });
  audio.unlock();
  const ctx = instances[0];
  ctx.builtAtUnlock = ctx.nodes.length;
  const lead = musicVoices(ctx)[0];
  let attempts = 0;
  lead.osc.frequency.setValueAtTime = () => { attempts++; throw new TypeError('non-finite'); };
  assert.doesNotThrow(() => audio.setMusicActive(true));
  assert.equal(audio.musicFailed, true);
  assert.equal(audio.musicPlaying, false);
  assert.doesNotThrow(() => {
    for (let i = 0; i < 60; i++) { audio.setMusicActive(true); audio.tick(); }   // a second of frames
    audio.restartMusic(); audio.toggleMusic(); audio.toggleMusic();
  });
  assert.equal(audio.musicPlaying, false, 'stays off');
  assert.equal(attempts, 1, 'no retry storm: the failing call is not attempted every frame');
  assert.doesNotThrow(() => audio.play('move'), 'effects still work');
});

test('mute with a broken master gain automation does not throw', () => {
  const { audio, ctx } = unlocked();
  const master = ctx.nodes.find((n) => n.kind === 'gain' && n.connectedTo === ctx.destination);
  master.gain.setTargetAtTime = () => { throw new Error('closed'); };
  assert.doesNotThrow(() => audio.setMuted(true));
  assert.equal(master.gain.value, 0, 'falls back to setting the value directly');
});
