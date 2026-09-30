import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyActions, createDasState, stepDas, createInput } from '../src/input.js';
import { DAS_FRAMES, ARR_FRAMES } from '../src/config.js';

// ---------- helpers ----------

/** Runs stepDas over a per-poll list of [dir, fresh] and returns poll indices that shifted. */
function dasSchedule(inputs, dasFrames = DAS_FRAMES, arrFrames = ARR_FRAMES) {
  const das = createDasState();
  const shifts = [];
  inputs.forEach(([dir, fresh], i) => {
    const s = stepDas(das, dir, fresh, dasFrames, arrFrames);
    if (s !== 0) shifts.push([i, s]);
  });
  return shifts;
}

/** Holding `dir` for n polls (fresh on the first). */
const hold = (dir, n) => Array.from({ length: n }, (_, i) => [dir, i === 0]);

function fakeTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ??= new Set()).add(fn); },
    removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    emit(type, event = {}) { for (const fn of listeners[type] ?? []) fn(event); },
    count(type) { return listeners[type]?.size ?? 0; },
  };
}

function keyEvent(code, repeat = false) {
  return { code, repeat, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

function setup(timing) {
  const target = fakeTarget();
  const input = createInput(target, undefined, timing);
  const down = (code, repeat = false) => { const e = keyEvent(code, repeat); target.emit('keydown', e); return e; };
  const up = (code) => { const e = keyEvent(code); target.emit('keyup', e); return e; };
  /** Polls n times and returns the poll indices where shift ≠ 0. */
  const shifts = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const { shift } = input.poll();
      if (shift !== 0) out.push([i, shift]);
    }
    return out;
  };
  return { target, input, down, up, shifts };
}

// ---------- config ----------

test('config: responsive DAS 10 / ARR 2 frames', () => {
  assert.equal(DAS_FRAMES, 10);
  assert.equal(ARR_FRAMES, 2);
});

// ---------- stepDas ----------

test('stepDas: held for 20 polls → shifts at 0, 10, 12, 14, 16, 18', () => {
  assert.deepEqual(dasSchedule(hold(-1, 20)), [[0, -1], [10, -1], [12, -1], [14, -1], [16, -1], [18, -1]]);
});

test('stepDas: NES timing 16 / 6 → shifts at 0, 16, 22, 28, 34', () => {
  assert.deepEqual(dasSchedule(hold(1, 40), 16, 6).map(([i]) => i), [0, 16, 22, 28, 34]);
});

test('stepDas: steady-state rate after charge is one shift per ARR frames', () => {
  const shifts = dasSchedule(hold(1, 10 + 60)).map(([i]) => i).filter((i) => i >= 10);
  assert.equal(shifts.length, 30); // 60 frames / ARR 2
});

test('stepDas: releasing resets state and charge', () => {
  const das = createDasState();
  for (let i = 0; i < 8; i++) stepDas(das, -1, i === 0, 10, 2);
  assert.equal(stepDas(das, 0, false, 10, 2), 0);
  assert.deepEqual(das, { dir: 0, frames: 0 });
  // Pressing again: immediate shift, then a full 10-frame charge
  assert.deepEqual(dasSchedule([...hold(-1, 8), [0, false], ...hold(-1, 12)]).map(([i]) => i), [0, 9, 19]);
});

test('stepDas: switching direction shifts immediately and restarts the charge', () => {
  const shifts = dasSchedule([...hold(-1, 15), ...hold(1, 12)]);
  assert.deepEqual(shifts, [[0, -1], [10, -1], [12, -1], [14, -1], [15, 1], [25, 1]]);
});

test('stepDas: a fresh press restarts the charge even in the same direction', () => {
  const inputs = hold(-1, 30);
  inputs[13] = [-1, true];
  assert.deepEqual(dasSchedule(inputs).map(([i]) => i), [0, 10, 12, 13, 23, 25, 27, 29]);
});

test('stepDas: ARR 0 shifts every poll once charged', () => {
  assert.deepEqual(dasSchedule(hold(1, 14), 10, 0).map(([i]) => i), [0, 10, 11, 12, 13]);
});

test('stepDas: only ever returns -1, 0 or 1', () => {
  const das = createDasState();
  for (let i = 0; i < 200; i++) {
    assert.ok([-1, 0, 1].includes(stepDas(das, i < 100 ? 1 : -1, false, 3, 0)));
  }
});

// ---------- createInput ----------

test('emptyActions has exactly the fields poll() returns', () => {
  const { input } = setup();
  assert.deepEqual(Object.keys(input.poll()).sort(), Object.keys(emptyActions()).sort());
  assert.deepEqual(input.poll(), emptyActions());
});

test('listeners: keydown, keyup and blur registered; destroy removes them', () => {
  const { target, input } = setup();
  for (const t of ['keydown', 'keyup', 'blur']) assert.equal(target.count(t), 1, t);
  input.destroy();
  for (const t of ['keydown', 'keyup', 'blur']) assert.equal(target.count(t), 0, t);
});

test('held key follows the DAS schedule through poll()', () => {
  const { down, shifts } = setup();
  down('ArrowLeft');
  assert.deepEqual(shifts(20), [[0, -1], [10, -1], [12, -1], [14, -1], [16, -1], [18, -1]]);
});

test('a tap released before the next poll still shifts exactly once', () => {
  const { down, up, shifts } = setup();
  down('ArrowRight');
  up('ArrowRight');
  assert.deepEqual(shifts(15), [[0, 1]]);
});

test('browser key-repeat is ignored and does not restart DAS', () => {
  const { down, shifts } = setup();
  down('KeyA');
  const first = shifts(5);
  for (let i = 0; i < 5; i++) down('KeyA', true);
  assert.deepEqual([...first, ...shifts(15).map(([i, s]) => [i + 5, s])],
    [[0, -1], [10, -1], [12, -1], [14, -1], [16, -1], [18, -1]]);
});

test('a repeat event without a prior keydown does not register a press', () => {
  const { input, down } = setup();
  down('Space', true);
  assert.equal(input.poll().hardDrop, false);
});

test('preventDefault on bound keys (incl. repeats and keyup), not on unbound keys', () => {
  const { down, up } = setup();
  assert.ok(down('ArrowDown').defaultPrevented);
  assert.ok(down('ArrowDown', true).defaultPrevented);
  assert.ok(up('ArrowDown').defaultPrevented);
  assert.ok(down('Space').defaultPrevented);
  assert.equal(down('KeyQ').defaultPrevented, false);
  assert.equal(down('F5').defaultPrevented, false);
  assert.equal(up('KeyQ').defaultPrevented, false);
});

test('aliases: releasing KeyA while ArrowLeft is still down keeps sliding', () => {
  const { down, up, shifts } = setup();
  down('ArrowLeft');
  down('KeyA');              // second alias: not a new press
  up('KeyA');
  assert.deepEqual(shifts(12), [[0, -1], [10, -1]]);
});

test('last pressed wins: Left held + Right → +1, release Right → -1 immediately', () => {
  const { input, down, up } = setup();
  down('ArrowLeft');
  assert.equal(input.poll().shift, -1);
  input.poll();
  down('ArrowRight');
  assert.equal(input.poll().shift, 1);
  assert.equal(input.poll().shift, 0);
  up('ArrowRight');
  assert.equal(input.poll().shift, -1);
});

test('blur clears held keys and DAS', () => {
  const { target, input, down } = setup();
  down('ArrowLeft');
  down('ArrowDown');
  input.poll();
  target.emit('blur');
  assert.deepEqual(input.poll(), emptyActions());
});

test('reset() drops unpolled press edges', () => {
  const { input, down } = setup();
  down('Space');
  down('KeyC');
  input.reset();
  assert.deepEqual(input.poll(), emptyActions());
});

test('edge actions fire once per press, not while held', () => {
  const { input, down, up } = setup();
  down('Space');
  down('KeyC');
  down('KeyP');
  down('Enter');
  down('KeyM');
  const first = input.poll();
  assert.deepEqual(
    [first.hardDrop, first.hold, first.pause, first.start, first.mute], [true, true, true, true, true]);
  const second = input.poll();
  assert.deepEqual(
    [second.hardDrop, second.hold, second.pause, second.start, second.mute], [false, false, false, false, false]);
  up('Space');
  down('Space');
  assert.equal(input.poll().hardDrop, true);
});

test('rotate: ArrowUp / KeyX / KeyW → 1, KeyZ → -1, CW wins when both', () => {
  for (const code of ['ArrowUp', 'KeyX', 'KeyW']) {
    const { input, down } = setup();
    down(code);
    assert.equal(input.poll().rotate, 1, code);
    assert.equal(input.poll().rotate, 0, `${code} held`);
  }
  const ccw = setup();
  ccw.down('KeyZ');
  assert.equal(ccw.input.poll().rotate, -1);
  const both = setup();
  both.down('KeyZ');
  both.down('KeyX');
  assert.equal(both.input.poll().rotate, 1);
});

test('softDrop: true while held, and for one poll on a tap', () => {
  const { input, down, up } = setup();
  down('KeyS');
  assert.equal(input.poll().softDrop, true);
  assert.equal(input.poll().softDrop, true);
  up('KeyS');
  assert.equal(input.poll().softDrop, false);
  down('ArrowDown');
  up('ArrowDown');
  assert.equal(input.poll().softDrop, true);
  assert.equal(input.poll().softDrop, false);
});

test('menuX: horizontal press edges only', () => {
  const { input, down } = setup();
  down('ArrowRight');
  assert.equal(input.poll().menuX, 1);
  assert.equal(input.poll().menuX, 0);
  down('KeyA');
  assert.equal(input.poll().menuX, -1);
});

test('shiftToWall: only with ARR 0, and only once charged', () => {
  const instant = setup({ dasFrames: 10, arrFrames: 0 });
  instant.down('ArrowLeft');
  const polls = Array.from({ length: 12 }, () => instant.input.poll());
  assert.deepEqual(polls.map((a) => a.shiftToWall),
    [false, false, false, false, false, false, false, false, false, false, true, true]);
  assert.equal(polls[0].shift, -1);

  const normal = setup();
  normal.down('ArrowLeft');
  assert.ok(Array.from({ length: 30 }, () => normal.input.poll()).every((a) => !a.shiftToWall));
});

test('custom timing is honored', () => {
  const { down, shifts } = setup({ dasFrames: 16, arrFrames: 6 });
  down('ArrowRight');
  assert.deepEqual(shifts(30).map(([i]) => i), [0, 16, 22, 28]);
});
