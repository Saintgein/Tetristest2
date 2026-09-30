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
} = {}) {
  let ctx = null;
  let master = null;
  const channelGain = {};
  const playing = {};                         // channel → scheduled sources (for cutting)
  const waves = {};                           // cached PeriodicWaves
  const noise = {};                           // cached LFSR buffers
  let level = clamp01(volume);

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
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
  }

  return {
    /** Create / resume the AudioContext. Call from a user gesture (keydown, click). */
    unlock() {
      if (!Ctor) return;
      try {
        if (!ctx) build();
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      } catch {
        ctx = null;                          // blocked or unsupported: stay silent
      }
    },

    play(name) {
      const recipe = RECIPES[name];
      if (!ctx || !recipe) return;
      try {
        const t0 = ctx.currentTime;
        const used = new Set(recipe.map((n) => n.ch));
        for (const ch of used) cut(ch, t0);
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

    get muted() { return muted; },
    get ready() { return ctx !== null; },
  };
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
}
