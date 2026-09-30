import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGravity, GRAVITY_EPSILON } from '../src/progression.js';
import { SOFT_DROP_G } from '../src/config.js';

const NES_FRAMES_PER_ROW = [
  48, 43, 38, 33, 28, 23, 18, 13, 8, 6,
  5, 5, 5, 4, 4, 4, 3, 3, 3, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 1,
];

// The SPEC §9.1 gravity accumulator with collisions left out. Returns the frame
// number (1-based) on which each row step happened.
function stepFrames(g, frames, threshold = 1 - GRAVITY_EPSILON) {
  let acc = 0;
  const steps = [];
  for (let f = 1; f <= frames; f++) {
    acc += g;
    while (acc >= threshold) {
      acc = Math.max(0, acc - 1);
      steps.push(f);
    }
  }
  return steps;
}

test('getGravity: NES table for levels 0–29', () => {
  NES_FRAMES_PER_ROW.forEach((frames, level) => {
    assert.equal(getGravity(level), 1 / frames, `level ${level}`);
  });
});

test('getGravity: spot checks across the full range', () => {
  assert.equal(getGravity(0), 1 / 48);
  assert.equal(getGravity(9), 1 / 6);
  assert.equal(getGravity(18), 1 / 3);
  assert.equal(getGravity(19), 1 / 2);
  assert.equal(getGravity(28), 1 / 2);
  assert.equal(getGravity(29), 1);
  assert.equal(getGravity(64), 10.5);
  assert.equal(getGravity(99), 20);
});

test('getGravity: never decreases, strictly increases from 29 to 99', () => {
  for (let l = 1; l <= 99; l++) {
    assert.ok(getGravity(l) >= getGravity(l - 1), `level ${l}`);
    if (l > 29) assert.ok(getGravity(l) > getGravity(l - 1), `level ${l}`);
  }
});

test('getGravity: clamps and floors out-of-range input', () => {
  assert.equal(getGravity(-5), getGravity(0));
  assert.equal(getGravity(150), 20);
  assert.equal(getGravity(12.9), getGravity(12));
  assert.equal(getGravity(NaN), getGravity(0));
  assert.equal(getGravity(Infinity), getGravity(0));
});

test('accumulator: levels 0–29 step exactly every framesPerRow frames for 100 rows', () => {
  NES_FRAMES_PER_ROW.forEach((framesPerRow, level) => {
    const steps = stepFrames(getGravity(level), framesPerRow * 100);
    assert.equal(steps.length, 100, `level ${level} row count`);
    steps.forEach((frame, i) => {
      assert.equal(frame, framesPerRow * (i + 1), `level ${level} row ${i + 1}`);
    });
  });
});

test('accumulator: 5f − 1 frames → 4 rows, 5f frames → 5 rows (levels 0–28)', () => {
  for (let level = 0; level <= 28; level++) {
    const f = NES_FRAMES_PER_ROW[level];
    const g = getGravity(level);
    assert.equal(stepFrames(g, 5 * f - 1).length, 4, `level ${level}`);
    assert.equal(stepFrames(g, 5 * f).length, 5, `level ${level}`);
  }
});

test('accumulator: without GRAVITY_EPSILON, levels 2–5, 7 and 9 run a frame late', () => {
  // Documents why the epsilon exists; if this ever passes with a plain `>= 1`,
  // the float behavior changed and SPEC §8.1 should be revisited.
  const late = [];
  for (let level = 0; level <= 28; level++) {
    const f = NES_FRAMES_PER_ROW[level];
    if (stepFrames(getGravity(level), f, 1)[0] !== f) late.push(level);
  }
  assert.deepEqual(late, [2, 3, 4, 5, 7, 9]);
});

test('accumulator: multi-G levels move floor(n × G) rows over n frames', () => {
  for (const level of [30, 45, 64, 80, 99]) {
    const g = getGravity(level);
    for (const n of [1, 7, 60]) {
      assert.equal(stepFrames(g, n).length, Math.floor(n * g + GRAVITY_EPSILON), `level ${level}, ${n} frames`);
    }
  }
  assert.equal(stepFrames(getGravity(99), 1).length, 20);
});

test('soft drop: max(G, SOFT_DROP_G) → 1 row per 2 frames at slow levels, no slowdown at fast ones', () => {
  const soft = (level) => Math.max(getGravity(level), SOFT_DROP_G);
  assert.equal(SOFT_DROP_G, 0.5);
  assert.deepEqual(stepFrames(soft(0), 10), [2, 4, 6, 8, 10]);
  assert.deepEqual(stepFrames(soft(18), 10), [2, 4, 6, 8, 10]);
  assert.equal(soft(29), getGravity(29));
  assert.equal(soft(99), 20);
});
