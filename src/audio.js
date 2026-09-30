// ==========================================================================
//  src/audio.js
//  2A03-style sound effects with the Web Audio API (SPEC §6.7).
//
//  Four channels like the NES APU: pulse 1 and pulse 2 (8-step duty
//  sequencer: 12.5 / 25 / 50 / 75 %), triangle (32-step 4-bit staircase) and
//  noise (15-bit LFSR, long or short mode). Each channel plays one sound at a
//  time: a new sound on a channel cuts the one before it, as on hardware.
//
//  Everything is synthesized at runtime; no audio assets. All methods are safe
//  no-ops when Web Audio is missing or the context isn't unlocked yet.
// ==========================================================================

/** @typedef {'move'|'rotate'|'softDrop'|'hardDrop'|'lock'|'hold'|'single'|'double'|'triple'|'tetris'|'levelUp'|'gameOver'|'pause'} SfxName */

export const CHANNELS = ['pulse1', 'pulse2', 'triangle', 'noise'];

/** Relative channel levels, roughly the APU's non-linear mixer. */
const CHANNEL_LEVEL = { pulse1: 0.22, pulse2: 0.22, triangle: 0.4, noise: 0.25 };

const DEFAULT_VOLUME = 0.6;
const HARMONICS = 48;
const RELEASE_S = 0.004;                      // tiny ramp so cut notes don't click

/** MIDI note → Hz (A4 = 69 = 440 Hz). */
export const noteFreq = (midi) => 440 * 2 ** ((midi - 69) / 12);

// ---------------------------------------------------------------------------
// Waveforms (pure; exported for tests)
// ---------------------------------------------------------------------------

/** 2A03 pulse duty sequences (one period, 8 steps). */
export const DUTY_STEPS = {
  0.125: [1, -1, -1, -1, -1, -1, -1, -1],
  0.25: [1, 1, -1, -1, -1, -1, -1, -1],
  0.5: [1, 1, 1, 1, -1, -1, -1, -1],
  0.75: [1, 1, 1, 1, 1, 1, -1, -1],
};

/** 2A03 triangle: 32-step staircase 15…0…15, scaled to ±1. */
export const TRIANGLE_STEPS = Array.from({ length: 32 }, (_, i) => {
  const level = i < 16 ? 15 - i : i - 16;
  return (level / 7.5) - 1;
});

/**
 * Exact Fourier series of a periodic step function (equal-width steps over
 * one period), as `real` (cos) / `imag` (sin) arrays for createPeriodicWave.
 * Index 0 (DC) is left at 0.
 */
export function stepWaveCoefficients(steps, harmonics = HARMONICS) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  const width = (2 * Math.PI) / steps.length;
  for (let n = 1; n <= harmonics; n++) {
    let a = 0, b = 0;
    for (let k = 0; k < steps.length; k++) {
      const t0 = k * width, t1 = t0 + width;
      a += steps[k] * (Math.sin(n * t1) - Math.sin(n * t0));
      b += steps[k] * (Math.cos(n * t0) - Math.cos(n * t1));
    }
    real[n] = a / (n * Math.PI);
    imag[n] = b / (n * Math.PI);
  }
  return { real, imag };
}

/**
 * 2A03 noise: 15-bit LFSR, output high when bit 0 is clear.
 * Long mode taps bits 0 ⊕ 1 (period 32767); short mode taps 0 ⊕ 6 (period 93).
 * @returns {Float32Array} ±1 samples, one per LFSR clock
 */
export function lfsrSequence(mode, length) {
  const tap = mode === 'short' ? 6 : 1;
  const out = new Float32Array(length);
  let reg = 1;
  for (let i = 0; i < length; i++) {
    out[i] = reg & 1 ? -1 : 1;
    const feedback = (reg & 1) ^ ((reg >> tap) & 1);
    reg = (reg >> 1) | (feedback << 14);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sound effects: declarative note lists
//   ch: channel · at: start offset (s) · dur (s) · note (MIDI) or rate (noise clock, Hz)
//   to / toRate: slide target · vol: 0–1 · duty · mode: noise 'long' | 'short'
//   env: 'decay' (linear to 0, NES-style) or 'hold' (flat, quick release)
// ---------------------------------------------------------------------------

/** Arpeggio helper: notes spaced `step` seconds apart, starting at `offset`. */
const arp = (ch, notes, step, { offset = 0, ...extra } = {}) =>
  notes.map((note, i) => ({ ch, at: offset + i * step, dur: step, note, vol: 0.8, duty: 0.5, env: 'hold', ...extra }));

/** @type {Record<SfxName, object[]>} */
export const RECIPES = {
  move: [{ ch: 'pulse1', at: 0, dur: 0.03, note: 84, vol: 0.45, duty: 0.25 }],
  rotate: [
    { ch: 'pulse1', at: 0, dur: 0.035, note: 79, vol: 0.55, duty: 0.5, env: 'hold' },
    { ch: 'pulse1', at: 0.035, dur: 0.04, note: 86, vol: 0.5, duty: 0.5 },
  ],
  softDrop: [{ ch: 'noise', at: 0, dur: 0.04, rate: 180_000, vol: 0.35, mode: 'short' }],
  hardDrop: [
    { ch: 'noise', at: 0, dur: 0.14, rate: 90_000, toRate: 8_000, vol: 0.9, mode: 'long' },
    { ch: 'triangle', at: 0, dur: 0.1, note: 45, to: 33, vol: 1, env: 'hold' },
  ],
  lock: [
    { ch: 'noise', at: 0, dur: 0.05, rate: 30_000, vol: 0.55, mode: 'long' },
    { ch: 'triangle', at: 0, dur: 0.04, note: 40, vol: 0.9, env: 'hold' },
  ],
  hold: [
    { ch: 'pulse2', at: 0, dur: 0.05, note: 81, vol: 0.6, duty: 0.125, env: 'hold' },
    { ch: 'pulse2', at: 0.05, dur: 0.06, note: 76, vol: 0.55, duty: 0.125 },
  ],
  single: arp('pulse1', [72, 79], 0.06),
  double: arp('pulse1', [72, 76, 79], 0.055),
  triple: [
    ...arp('pulse1', [72, 76, 79, 84], 0.05),
    ...arp('pulse2', [64, 67, 72], 0.066, { vol: 0.5, duty: 0.25 }),
  ],
  // Fanfare: melody + harmony + bass + a noise crash
  tetris: [
    ...arp('pulse1', [72, 76, 79, 84, 88], 0.07),
    { ch: 'pulse1', at: 0.35, dur: 0.35, note: 91, vol: 0.85, duty: 0.5 },
    ...arp('pulse2', [67, 72, 76, 79, 84], 0.07, { vol: 0.55, duty: 0.25 }),
    { ch: 'pulse2', at: 0.35, dur: 0.35, note: 88, vol: 0.55, duty: 0.25 },
    { ch: 'triangle', at: 0, dur: 0.35, note: 48, vol: 1, env: 'hold' },
    { ch: 'triangle', at: 0.35, dur: 0.35, note: 36, vol: 1 },
    { ch: 'noise', at: 0, dur: 0.25, rate: 60_000, vol: 0.5, mode: 'long' },
  ],
  levelUp: [
    ...arp('pulse1', [79, 83, 86, 91], 0.06, { duty: 0.25 }),
    ...arp('pulse2', [74, 79, 83, 86], 0.06, { offset: 0.03, duty: 0.125, vol: 0.4 }),   // echo
  ],
  gameOver: [
    ...[76, 74, 72, 71, 69, 67, 65, 64].map((note, i) => ({
      ch: 'pulse1', at: i * 0.13, dur: 0.13, note, vol: 0.7, duty: 0.5, env: i === 7 ? 'decay' : 'hold',
    })),
    { ch: 'triangle', at: 0, dur: 0.52, note: 52, vol: 1, env: 'hold' },
    { ch: 'triangle', at: 0.52, dur: 0.52, note: 45, vol: 1, env: 'hold' },
    { ch: 'triangle', at: 1.04, dur: 0.3, note: 40, vol: 1 },
  ],
  pause: [
    { ch: 'pulse1', at: 0, dur: 0.05, note: 88, vol: 0.5, duty: 0.25, env: 'hold' },
    { ch: 'pulse1', at: 0.06, dur: 0.05, note: 81, vol: 0.5, duty: 0.25, env: 'hold' },
    { ch: 'pulse1', at: 0.12, dur: 0.08, note: 88, vol: 0.5, duty: 0.25 },
  ],
};

export const SFX_NAMES = Object.keys(RECIPES);

/** Per effect: when (s after start) it releases each channel — used to duck the music. */
const RECIPE_CHANNEL_END = Object.fromEntries(SFX_NAMES.map((name) => {
  const ends = {};
  for (const n of RECIPES[name]) ends[n.ch] = Math.max(ends[n.ch] ?? 0, n.at + n.dur);
  return [name, ends];
}));

// ---------------------------------------------------------------------------
// Background music: "Korobeiniki" (Russian folk song, public domain),
// arranged for 3 voices. A section twice, then B. A minor, 140 BPM, 4/4.
// Notation: NOTE:beats, R = rest, | = bar line (checked: every bar is 4 beats).
// ---------------------------------------------------------------------------

const LEAD_A = [
  'E5:1 B4:.5 C5:.5 D5:1 C5:.5 B4:.5', 'A4:1 A4:.5 C5:.5 E5:1 D5:.5 C5:.5',
  'B4:1.5 C5:.5 D5:1 E5:1', 'C5:1 A4:1 A4:2',
  'D5:1.5 F5:.5 A5:1 G5:.5 F5:.5', 'E5:1.5 C5:.5 E5:1 D5:.5 C5:.5',
  'B4:1 B4:.5 C5:.5 D5:1 E5:1', 'C5:1 A4:1 A4:1 R:1',
];
const LEAD_B = [
  'E5:2 C5:2', 'D5:2 B4:2', 'C5:2 A4:2', 'G#4:2 B4:1 R:1',
  'E5:2 C5:2', 'D5:2 B4:2', 'C5:1 E5:1 A5:2', 'G#5:4',
];
const HARMONY_A = [
  'G#4:2 E4:2', 'A4:2 E4:2', 'G#4:2 B4:2', 'A4:2 E4:2',
  'F4:2 A4:2', 'E4:2 G4:2', 'G#4:2 E4:2', 'E4:2 R:2',
];
const HARMONY_B = [
  'A4:2 E4:2', 'G#4:2 E4:2', 'A4:2 E4:2', 'E4:2 G#4:1 R:1',
  'A4:2 E4:2', 'G#4:2 E4:2', 'A4:2 C5:2', 'B4:4',
];
// Walking bass, one chord-tone/passing-tone quarter per beat: E Am E Am Dm C E Am | Am E …
const BASS_A = [
  'E2:1 G#2:1 B2:1 G#2:1', 'A2:1 C3:1 E3:1 C3:1', 'E2:1 G#2:1 B2:1 D3:1', 'A2:1 E2:1 A2:1 C3:1',
  'D3:1 A2:1 F2:1 A2:1', 'C3:1 G2:1 C3:1 D3:1', 'E3:1 B2:1 G#2:1 E2:1', 'A2:1 C3:1 B2:1 G#2:1',
];
const BASS_B = [
  'A2:1 C3:1 E3:1 C3:1', 'E2:1 G#2:1 B2:1 G#2:1', 'A2:1 C3:1 E3:1 C3:1', 'E2:1 G#2:1 B2:1 E3:1',
  'A2:1 C3:1 E3:1 A3:1', 'G#3:1 E3:1 B2:1 G#2:1', 'A2:1 C3:1 E3:1 C3:1', 'E2:1 B2:1 E3:1 G#2:1',
];

const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "G#4" → MIDI 68. */
export function parseNote(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

/**
 * Compiles bars of "NOTE:beats" into typed arrays (done once at load, so the
 * sequencer never parses or allocates while playing).
 * @returns {{ starts: Float64Array, durs: Float64Array, freqs: Float64Array, midi: Int8Array, beats: number }}
 */
export function compileVoice(bars) {
  const notes = [];
  let beat = 0;
  bars.forEach((bar, b) => {
    let barBeats = 0;
    for (const token of bar.trim().split(/\s+/)) {
      const [name, len] = token.split(':');
      const dur = Number(len);
      notes.push({ beat, dur, midi: name === 'R' ? -1 : parseNote(name) });
      beat += dur;
      barBeats += dur;
    }
    if (barBeats !== 4) throw new Error(`bar ${b + 1} has ${barBeats} beats`);
  });
  const n = notes.length;
  const voice = { starts: new Float64Array(n), durs: new Float64Array(n), freqs: new Float64Array(n), midi: new Int8Array(n), beats: beat };
  notes.forEach((note, i) => {
    voice.starts[i] = note.beat;
    voice.durs[i] = note.dur;
    voice.midi[i] = note.midi;
    voice.freqs[i] = note.midi < 0 ? 0 : noteFreq(note.midi);
  });
  return voice;
}

const song = (a, b) => [...a, ...a, ...b];

/** The looping background track. `gate` shortens notes for articulation. */
export const BGM = {
  title: 'Korobeiniki (trad.)',
  tempo: 140,
  voices: [
    { name: 'lead', channel: 'pulse1', duty: 0.25, vol: 0.55, gate: 0.9, ...compileVoice(song(LEAD_A, LEAD_B)) },
    { name: 'harmony', channel: 'pulse2', duty: 0.5, vol: 0.3, gate: 0.95, ...compileVoice(song(HARMONY_A, HARMONY_B)) },
    { name: 'bass', channel: 'triangle', duty: null, vol: 0.85, gate: 0.8, ...compileVoice(song(BASS_A, BASS_B)) },
  ],
};
BGM.lengthBeats = BGM.voices[0].beats;         // 24 bars × 4 = 96 beats (~41 s)

const SECONDS_PER_BEAT = 60 / BGM.tempo;
/** How far ahead notes are scheduled: one measure, so a stall never starves the loop. */
export const MUSIC_LOOKAHEAD_S = 4 * SECONDS_PER_BEAT;
const MUSIC_LEVEL = 0.55;                      // music sits under the effects
const MUSIC_START_DELAY_S = 0.05;
const NOTE_ATTACK_S = 0.004;
const NOTE_RELEASE_S = 0.02;
const DUCK_LEVEL = 0;                          // an effect takes its channel over completely
const MAX_NOTES_PER_TICK = 256;                // per voice; far above one lookahead measure

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * @param {{ AudioContext?: Function, volume?: number, muted?: boolean }} [options]
 * @returns {{ play(name: SfxName): void, unlock(): void, setMuted(m: boolean): void,
 *             toggleMute(): boolean, setVolume(v: number): void, readonly muted: boolean,
 *             readonly ready: boolean }}
 */
export function createAudio({
  AudioContext: Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  volume = DEFAULT_VOLUME,
  muted = false,
  musicEnabled = true,
} = {}) {
  let ctx = null;
  let master = null;
  let musicGain = null;
  const channelGain = {};
  const playing = {};                         // channel → scheduled sources (for cutting)
  const waves = {};                           // cached PeriodicWaves
  const noise = {};                           // cached LFSR buffers
  let level = clamp01(volume);

  // Sequencer state. Everything is preallocated; tick() only reads and writes
  // numbers, so it can run every frame without allocating.
  const music = {
    enabled: Boolean(musicEnabled),         // player preference (B key)
    wanted: false,                          // the game is in play (not title / paused / game over)
    active: false,                          // notes are being scheduled right now
    anchorTime: 0,                          // ctx time of anchorBeat
    anchorBeat: 0,                          // absolute beat (loops included) where playback (re)started
    resumeBeat: 0,                          // where to continue after a pause
    failed: false,                          // Web Audio threw during music: off for this session
    voices: [],                             // { data, osc, env, duck, i, loopBase, fromBeat }
  };
  const voiceByChannel = {};

  function build() {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : level;
    master.connect(ctx.destination);
    for (const ch of CHANNELS) {
      channelGain[ch] = ctx.createGain();
      channelGain[ch].gain.value = CHANNEL_LEVEL[ch];
      channelGain[ch].connect(master);
      playing[ch] = [];
    }
    buildMusic();
  }

  /** One persistent oscillator per voice: notes are just frequency/gain automation on it. */
  function buildMusic() {
    musicGain = ctx.createGain();
    musicGain.gain.value = MUSIC_LEVEL;
    musicGain.connect(master);
    music.voices = BGM.voices.map((data) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(data.channel === 'triangle'
        ? wave('triangle', TRIANGLE_STEPS)
        : wave(`duty${data.duty}`, DUTY_STEPS[data.duty]));
      const env = ctx.createGain();           // note envelopes
      env.gain.value = 0;
      const duckGain = ctx.createGain();      // effects on this channel take precedence
      duckGain.gain.value = 1;
      const mix = ctx.createGain();
      mix.gain.value = CHANNEL_LEVEL[data.channel] * data.vol;
      osc.connect(env);
      env.connect(duckGain);
      duckGain.connect(mix);
      mix.connect(musicGain);
      osc.start(ctx.currentTime);
      const voice = { data, osc, env, duck: duckGain, i: 0, loopBase: 0, fromBeat: 0 };
      voiceByChannel[data.channel] = voice;
      return voice;
    });
  }

  const timeAt = (beat) => music.anchorTime + (beat - music.anchorBeat) * SECONDS_PER_BEAT;
  const beatAt = (time) => music.anchorBeat + (time - music.anchorTime) / SECONDS_PER_BEAT;

  /**
   * Starts scheduling from music.resumeBeat (0 = top; a mid-note position resumes that note).
   * Reads the beat from state rather than taking it as a parameter: a fractional
   * argument would be boxed into a HeapNumber on every resume (measured).
   */
  function startMusic() {
    const fromBeat = music.resumeBeat;
    music.anchorTime = ctx.currentTime + MUSIC_START_DELAY_S;
    music.anchorBeat = fromBeat;
    const length = BGM.lengthBeats;
    const loopBase = Math.floor(fromBeat / length) * length;
    const inLoop = fromBeat - loopBase;
    for (let k = 0; k < music.voices.length; k++) {
      const v = music.voices[k];
      const { starts, durs } = v.data;
      let i = 0;
      while (i < starts.length && starts[i] + durs[i] <= inLoop) i++;
      v.i = i === starts.length ? 0 : i;
      v.loopBase = i === starts.length ? loopBase + length : loopBase;
      v.fromBeat = fromBeat;
    }
    music.active = true;
    tickMusic();
  }

  function scheduleNote(v, freq, t0, t1) {
    if (t1 - t0 < 2 * NOTE_ATTACK_S) return;   // sliver left over after a pause: skip
    const g = v.env.gain;
    v.osc.frequency.setValueAtTime(freq, t0);
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(1, t0 + NOTE_ATTACK_S);
    g.setValueAtTime(1, Math.max(t0 + NOTE_ATTACK_S, t1 - NOTE_RELEASE_S));
    g.linearRampToValueAtTime(0, t1);
  }

  /** Schedules every note that starts before now + lookahead. Allocation-free. */
  function tickMusic() {
    const horizon = ctx.currentTime + MUSIC_LOOKAHEAD_S;
    const length = BGM.lengthBeats;
    for (let k = 0; k < music.voices.length; k++) {
      const v = music.voices[k];
      const d = v.data;
      // A measure holds at most 32 notes; the cap only guards against a data or
      // timing bug turning this into an infinite loop that would freeze the game.
      for (let guard = 0; guard < MAX_NOTES_PER_TICK; guard++) {
        const noteStart = v.loopBase + d.starts[v.i];
        const from = noteStart > v.fromBeat ? noteStart : v.fromBeat;   // resumed mid-note
        const t0 = timeAt(from);
        if (t0 >= horizon) break;
        const gateEnd = noteStart + d.durs[v.i] * d.gate;
        if (d.freqs[v.i] > 0 && gateEnd > from) scheduleNote(v, d.freqs[v.i], t0, timeAt(gateEnd));
        v.i++;
        if (v.i === d.starts.length) {      // seamless loop: the next pass continues the same timeline
          v.i = 0;
          v.loopBase += length;
        }
      }
    }
  }

  function pauseMusic() {
    const now = ctx.currentTime;
    music.resumeBeat = Math.max(music.anchorBeat, beatAt(now));
    for (let k = 0; k < music.voices.length; k++) {
      const v = music.voices[k];
      v.env.gain.cancelScheduledValues(now);
      v.env.gain.setTargetAtTime(0, now, 0.005);   // fade from wherever it is: no click
      v.osc.frequency.cancelScheduledValues(now);
    }
    music.active = false;
  }

  /**
   * Runs a music operation; if the browser's Web Audio throws (strict engines reject
   * odd automation values, a context can be closed under us), music is switched off
   * for the session instead of the error reaching the game loop every frame.
   * Sound effects are unaffected.
   */
  function guardMusic(operation) {
    try {
      operation();
    } catch {
      music.failed = true;
      music.active = false;
      for (let k = 0; k < music.voices.length; k++) {
        try { music.voices[k].env.gain.cancelScheduledValues(0); music.voices[k].env.gain.value = 0; } catch { /* ignore */ }
      }
    }
  }

  /** Plays iff the context exists, the player wants music and the game is in play. */
  function reconcileMusic() {
    const should = ctx !== null && !music.failed && music.enabled && music.wanted;
    if (should && !music.active) startMusic();
    else if (!should && music.active) pauseMusic();
  }

  /** An effect takes over its channel: silence that music voice until the effect ends. */
  function duck(ch, t0, t1) {
    const v = voiceByChannel[ch];
    if (!v) return;
    const g = v.duck.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(DUCK_LEVEL, t0);
    g.setValueAtTime(1, t1);
  }

  function wave(key, steps) {
    if (!waves[key]) {
      const { real, imag } = stepWaveCoefficients(steps);
      waves[key] = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }
    return waves[key];
  }

  function noiseBuffer(mode) {
    if (!noise[mode]) {
      const samples = lfsrSequence(mode, mode === 'short' ? 93 : 32767);
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.getChannelData(0).set(samples);
      noise[mode] = buffer;
    }
    return noise[mode];
  }

  /** Stops everything scheduled on a channel from `time` on (hardware-style channel stealing). */
  function cut(ch, time) {
    for (const source of playing[ch]) {
      try { source.stop(time); } catch { /* already stopped */ }
    }
    playing[ch].length = 0;
  }

  function schedule(n, t0) {
    const start = t0 + n.at;
    const end = start + n.dur;
    const env = ctx.createGain();
    env.gain.setValueAtTime(n.vol, start);
    if (n.env === 'hold') env.gain.setValueAtTime(n.vol, Math.max(start, end - RELEASE_S));
    env.gain.linearRampToValueAtTime(0, end);
    env.connect(channelGain[n.ch]);

    let source;
    if (n.ch === 'noise') {
      source = ctx.createBufferSource();
      source.buffer = noiseBuffer(n.mode ?? 'long');
      source.loop = true;
      source.playbackRate.setValueAtTime(n.rate / ctx.sampleRate, start);
      if (n.toRate) source.playbackRate.linearRampToValueAtTime(n.toRate / ctx.sampleRate, end);
    } else {
      source = ctx.createOscillator();
      source.setPeriodicWave(n.ch === 'triangle' ? wave('triangle', TRIANGLE_STEPS) : wave(`duty${n.duty ?? 0.5}`, DUTY_STEPS[n.duty ?? 0.5]));
      source.frequency.setValueAtTime(noteFreq(n.note), start);
      if (n.to) source.frequency.linearRampToValueAtTime(noteFreq(n.to), end);
    }
    source.connect(env);
    source.start(start);
    source.stop(end + 0.01);
    const list = playing[n.ch];
    list.push(source);
    source.onended = () => {
      const i = list.indexOf(source);
      if (i >= 0) list.splice(i, 1);
      env.disconnect();
    };
  }

  function setMasterGain() {
    if (!master) return;
    const target = muted ? 0 : level;
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
    } catch {
      try { master.gain.value = target; } catch { /* context gone: nothing to mute */ }
    }
  }

  return {
    /** Create / resume the AudioContext. Call from a user gesture (keydown, click). */
    unlock() {
      if (!Ctor) return;
      // 1. Create the context once. If construction or graph setup fails (blocked,
      //    unsupported, too many contexts), close any half-built context so the next
      //    gesture can retry without leaking one per keypress.
      if (!ctx) {
        try {
          build();
        } catch {
          try { ctx?.close?.(); } catch { /* ignore */ }
          ctx = null;
          master = null;
          musicGain = null;
          return;                            // stay silent; the game carries on
        }
      }
      // 2. Resume. Strict autoplay policies reject the promise; old WebKit returns
      //    nothing at all. Neither may throw, and neither discards a working context.
      try {
        if (ctx.state === 'suspended') {
          const pending = ctx.resume();
          if (pending && typeof pending.then === 'function') pending.then(undefined, () => {});
        }
      } catch { /* resume() threw synchronously: retry on the next gesture */ }
      // 3. Start music if the game is already in play.
      guardMusic(reconcileMusic);
    },

    play(name) {
      const recipe = RECIPES[name];
      if (!ctx || !recipe) return;
      try {
        const t0 = ctx.currentTime;
        const used = new Set(recipe.map((n) => n.ch));
        const ends = RECIPE_CHANNEL_END[name];
        for (const ch of used) {
          cut(ch, t0);
          duck(ch, t0, t0 + ends[ch]);             // the music voice on this channel steps aside
        }
        for (const n of recipe) schedule(n, t0);
      } catch { /* never let a sound break the game */ }
    },

    setMuted(value) {
      muted = Boolean(value);
      setMasterGain();
    },

    toggleMute() {
      this.setMuted(!muted);
      return muted;
    },

    setVolume(value) {
      level = clamp01(value);
      setMasterGain();
    },

    // ---- background music ----

    /** Player preference (B key). Survives pauses; the game decides when music may play. */
    setMusicEnabled(value) {
      music.enabled = Boolean(value);
      if (ctx) guardMusic(reconcileMusic);
    },

    toggleMusic() {
      this.setMusicEnabled(!music.enabled);
      return music.enabled;
    },

    /** Game-driven: true while a game is in play, false on title / pause / game over. Idempotent. */
    setMusicActive(value) {
      music.wanted = value === true;
      if (ctx) guardMusic(reconcileMusic);
    },

    /** Back to bar 1 (new game). */
    restartMusic() {
      if (ctx && music.active) guardMusic(pauseMusic);
      music.resumeBeat = 0;
      if (ctx) guardMusic(reconcileMusic);
    },

    /** Call once per rendered frame: keeps one measure of notes scheduled ahead. */
    tick() {
      if (music.active) guardMusic(tickMusic);
    },

    get muted() { return muted; },
    get ready() { return ctx !== null; },
    get musicEnabled() { return music.enabled; },
    get musicPlaying() { return music.active; },
    get musicFailed() { return music.failed; },
    /** Current song position in beats (tests / debugging). */
    get musicBeat() {
      if (!ctx || !music.active) return music.resumeBeat;
      return Math.max(music.anchorBeat, beatAt(ctx.currentTime));
    },
  };
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
}
