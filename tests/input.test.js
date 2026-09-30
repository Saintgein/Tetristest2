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
  const polls = Array.from({ length: 12 }, () => ({ ...instant.input.poll() }));   // poll() reuses one object
  assert.deepEqual(polls.map((a) => a.shiftToWall),
    [false, false, false, false, false, false, false, false, false, false, true, true]);
  assert.equal(polls[0].shift, -1);

  const normal = setup();
  normal.down('ArrowLeft');
  assert.ok(Array.from({ length: 30 }, () => ({ ...normal.input.poll() })).every((a) => !a.shiftToWall));
});

test('custom timing is honored', () => {
  const { down, shifts } = setup({ dasFrames: 16, arrFrames: 6 });
  down('ArrowRight');
  assert.deepEqual(shifts(30).map(([i]) => i), [0, 16, 22, 28]);
});

test('poll() reuses one Actions object (no per-frame allocation)', () => {
  const { input, down } = setup();
  const first = input.poll();
  down('Space');
  const second = input.poll();
  assert.equal(second, first, 'same object');
  assert.equal(second.hardDrop, true, 'overwritten with this frame');
  assert.equal(input.poll().hardDrop, false);
});

test('B is the music toggle: a press edge, separate from M', () => {
  const { input, down } = setup();
  down('KeyB');
  const a = input.poll();
  assert.deepEqual([a.music, a.mute], [true, false]);
  assert.equal(input.poll().music, false, 'edge only');
});

// ===========================================================================
// Starting from the title screen: robust keys and click / tap
// ===========================================================================

function recordingTarget() {
  const listeners = {};
  const options = {};
  return {
    options,
    addEventListener(type, fn, opts) { (listeners[type] ??= new Set()).add(fn); options[type] = opts; },
    removeEventListener(type, fn, opts) { if (JSON.stringify(opts) === JSON.stringify(options[type])) listeners[type]?.delete(fn); },
    emit(type, event = {}) { for (const fn of listeners[type] ?? []) fn(event); },
    count(type) { return listeners[type]?.size ?? 0; },
  };
}

function keyEventWith(fields) {
  return { code: '', key: '', repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...fields };
}

test('Numpad Enter starts the game too', () => {
  const { input, down } = setup();
  down('NumpadEnter');
  assert.equal(input.poll().start, true);
});

test('fallback by key: an event with an empty code still works (remote desktops, virtual keyboards)', () => {
  const target = recordingTarget();
  const input = createInput(target);
  const enter = keyEventWith({ key: 'Enter' });
  target.emit('keydown', enter);
  assert.equal(enter.defaultPrevented, true, 'the browser does not get the key either');
  assert.equal(input.poll().start, true);

  target.emit('keydown', keyEventWith({ key: ' ' }));
  assert.equal(input.poll().hardDrop, true);
  target.emit('keydown', keyEventWith({ key: 'ArrowLeft' }));
  assert.equal(input.poll().shift, -1);
  target.emit('keyup', keyEventWith({ key: 'ArrowLeft' }));
  assert.equal(input.poll().shift, 0, 'released by the same fallback id');
});

test('fallback never re-maps letter keys: layouts stay physical', () => {
  const target = recordingTarget();
  const input = createInput(target);
  const q = keyEventWith({ code: 'KeyQ', key: 'a' });      // AZERTY: physical Q types 'a'
  target.emit('keydown', q);
  assert.equal(q.defaultPrevented, false);
  assert.deepEqual({ ...input.poll() }, emptyActions());
});

test('a code binding wins over the key fallback (no double press)', () => {
  const target = recordingTarget();
  const input = createInput(target);
  target.emit('keydown', keyEventWith({ code: 'Enter', key: 'Enter' }));
  target.emit('keydown', keyEventWith({ code: '', key: 'Enter' }));   // same key seen again without a code
  assert.equal(input.poll().start, true);
  assert.equal(input.poll().start, false);
});

test('IME composition: Enter that commits text is not a game key', () => {
  const target = recordingTarget();
  const input = createInput(target);
  for (const e of [keyEventWith({ code: 'Enter', key: 'Enter', isComposing: true }), keyEventWith({ code: 'Enter', key: 'Process', keyCode: 229 })]) {
    target.emit('keydown', e);
    assert.equal(e.defaultPrevented, false);
  }
  assert.equal(input.poll().start, false);
});

test('key listeners: capture phase, never passive; destroy removes them with the same options', () => {
  const target = recordingTarget();
  const input = createInput(target);
  assert.deepEqual(target.options.keydown, { capture: true, passive: false });
  assert.deepEqual(target.options.keyup, { capture: true, passive: false });
  input.destroy();
  for (const type of ['keydown', 'keyup', 'blur', 'pointerdown']) assert.equal(target.count(type), 0, type);
});

const pointer = (fields = {}) => ({ isPrimary: true, pointerType: 'mouse', button: 0, target: { closest: () => null }, ...fields });

test('click / tap anywhere presses Start (e.g. the page has no keyboard focus)', () => {
  const target = recordingTarget();
  const input = createInput(target);
  target.emit('pointerdown', pointer());
  assert.equal(input.poll().start, true, 'mouse left button');
  assert.equal(input.poll().start, false, 'an edge, not held');
  target.emit('pointerdown', pointer({ pointerType: 'touch', button: -1 }));
  assert.equal(input.poll().start, true, 'touch');
  target.emit('pointerdown', pointer({ pointerType: 'pen' }));
  assert.equal(input.poll().start, true, 'pen');
});

test('clicks that are not "start": right button, secondary pointers, buttons and links', () => {
  const target = recordingTarget();
  const input = createInput(target);
  target.emit('pointerdown', pointer({ button: 2 }));
  target.emit('pointerdown', pointer({ isPrimary: false }));
  target.emit('pointerdown', pointer({ target: { closest: (sel) => (sel.includes('button') ? {} : null) } }));
  assert.equal(input.poll().start, false);
});

test('pointerStart: false disables click-to-start', () => {
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { pointerStart: false });
  assert.equal(target.count('pointerdown'), 0);
  assert.equal(input.poll().start, false);
});

test('press(): programmatic press edges; unknown actions ignored', () => {
  const { input } = setup();
  input.press('start');
  input.press('explode');
  const a = input.poll();
  assert.equal(a.start, true);
  assert.equal(input.poll().start, false);
});

// ---------- Touch Controls & Multi-Touch ----------

function fakeTouchElement(action) {
  const listeners = {};
  const captures = new Set();
  const classList = {
    classes: new Set(),
    add(c) { this.classes.add(c); },
    remove(c) { this.classes.delete(c); },
    contains(c) { return this.classes.has(c); },
  };
  return {
    dataset: { action },
    getAttribute(name) { return name === 'data-action' ? action : null; },
    classList,
    addEventListener(type, fn) { (listeners[type] ??= new Set()).add(fn); },
    removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    emit(type, event = {}) {
      event.currentTarget = this;
      event.target ??= this;
      event.preventDefault ??= () => { event.defaultPrevented = true; };
      for (const fn of listeners[type] ?? []) fn(event);
      return event;
    },
    setPointerCapture(id) { captures.add(id); },
    releasePointerCapture(id) { captures.delete(id); },
    hasPointerCapture(id) { return captures.has(id); },
    count(type) { return listeners[type]?.size ?? 0; },
  };
}

function fakeTouchRoot(actions) {
  const buttons = actions.map((act) => fakeTouchElement(act));
  return {
    buttons,
    querySelectorAll(sel) {
      if (sel === '[data-action]') return buttons;
      return [];
    },
  };
}

const touchPointer = (id, fields = {}) => ({
  pointerId: id,
  pointerType: 'touch',
  button: 0,
  defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; },
  ...fields,
});

test('touch: tapping each virtual button sets its action on the next poll', () => {
  const root = fakeTouchRoot(['left', 'right', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'hold', 'pause']);
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { touchRoot: root });

  const btnByAction = Object.fromEntries(root.buttons.map((b) => [b.dataset.action, b]));

  // Left
  btnByAction.left.emit('pointerdown', touchPointer(1));
  btnByAction.left.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().shift, -1);
  assert.equal(input.poll().shift, 0);

  // Right
  btnByAction.right.emit('pointerdown', touchPointer(1));
  btnByAction.right.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().shift, 1);
  assert.equal(input.poll().shift, 0);

  // Soft Drop
  btnByAction.softDrop.emit('pointerdown', touchPointer(1));
  btnByAction.softDrop.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().softDrop, true);
  assert.equal(input.poll().softDrop, false);

  // Hard Drop
  btnByAction.hardDrop.emit('pointerdown', touchPointer(1));
  btnByAction.hardDrop.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().hardDrop, true);
  assert.equal(input.poll().hardDrop, false);

  // Rotate CW (A)
  btnByAction.rotateCW.emit('pointerdown', touchPointer(1));
  btnByAction.rotateCW.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().rotate, 1);
  assert.equal(input.poll().rotate, 0);

  // Rotate CCW (B)
  btnByAction.rotateCCW.emit('pointerdown', touchPointer(1));
  btnByAction.rotateCCW.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().rotate, -1);
  assert.equal(input.poll().rotate, 0);

  // Hold
  btnByAction.hold.emit('pointerdown', touchPointer(1));
  btnByAction.hold.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().hold, true);
  assert.equal(input.poll().hold, false);

  // Pause
  btnByAction.pause.emit('pointerdown', touchPointer(1));
  btnByAction.pause.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().pause, true);
  assert.equal(input.poll().pause, false);
});

test('touch: holding Left charges DAS and repeats with ARR', () => {
  const root = fakeTouchRoot(['left']);
  const target = recordingTarget();
  const input = createInput(target, undefined, { dasFrames: 10, arrFrames: 2 }, { touchRoot: root });
  const [btn] = root.buttons;

  btn.emit('pointerdown', touchPointer(1));
  assert.equal(btn.classList.contains('is-pressed'), true);

  const shifts = [];
  for (let i = 0; i < 15; i++) {
    const { shift } = input.poll();
    if (shift !== 0) shifts.push([i, shift]);
  }
  // Frame 0: initial shift. Frames 10, 12, 14: ARR repeat
  assert.deepEqual(shifts, [[0, -1], [10, -1], [12, -1], [14, -1]]);

  btn.emit('pointerup', touchPointer(1));
  assert.equal(btn.classList.contains('is-pressed'), false);
  assert.equal(input.poll().shift, 0);
});

test('touch: multi-touch holding Left while tapping Rotate CW', () => {
  const root = fakeTouchRoot(['left', 'rotateCW']);
  const target = recordingTarget();
  const input = createInput(target, undefined, { dasFrames: 10, arrFrames: 2 }, { touchRoot: root });
  const [btnLeft, btnRotate] = root.buttons;

  // Thumb 1 presses Left
  btnLeft.emit('pointerdown', touchPointer(1));
  const poll0 = input.poll();
  assert.equal(poll0.shift, -1);
  assert.equal(poll0.rotate, 0);

  // Thumb 2 taps Rotate CW while Thumb 1 continues holding Left
  btnRotate.emit('pointerdown', touchPointer(2));
  const poll1 = input.poll();
  assert.equal(poll1.rotate, 1, 'rotate triggered');
  assert.equal(poll1.shift, 0, 'DAS still charging');

  // Thumb 2 released
  btnRotate.emit('pointerup', touchPointer(2));
  assert.equal(btnRotate.classList.contains('is-pressed'), false);
  assert.equal(btnLeft.classList.contains('is-pressed'), true);

  // Poll through frames until DAS fires
  let dasFired = false;
  for (let i = 2; i <= 10; i++) {
    const a = input.poll();
    assert.equal(a.rotate, 0);
    if (i === 10) {
      assert.equal(a.shift, -1, 'DAS fires for held Left');
      dasFired = true;
    }
  }
  assert.ok(dasFired);

  // Thumb 1 released
  btnLeft.emit('pointerup', touchPointer(1));
  assert.equal(btnLeft.classList.contains('is-pressed'), false);
  assert.equal(input.poll().shift, 0);
});

test('touch: multi-touch holding Soft Drop while steering Left', () => {
  const root = fakeTouchRoot(['softDrop', 'left']);
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { touchRoot: root });
  const [btnDown, btnLeft] = root.buttons;

  btnDown.emit('pointerdown', touchPointer(1));
  assert.equal(input.poll().softDrop, true);

  btnLeft.emit('pointerdown', touchPointer(2));
  const both = input.poll();
  assert.equal(both.softDrop, true);
  assert.equal(both.shift, -1);

  btnLeft.emit('pointerup', touchPointer(2));
  const downOnly = input.poll();
  assert.equal(downOnly.softDrop, true);
  assert.equal(downOnly.shift, 0);

  btnDown.emit('pointerup', touchPointer(1));
  assert.equal(input.poll().softDrop, false);
});

test('touch: setPointerCapture and releasePointerCapture are called', () => {
  const root = fakeTouchRoot(['right']);
  const target = recordingTarget();
  createInput(target, undefined, undefined, { touchRoot: root });
  const [btn] = root.buttons;

  const down = btn.emit('pointerdown', touchPointer(5));
  assert.equal(down.defaultPrevented, true);
  assert.equal(btn.hasPointerCapture(5), true);

  const up = btn.emit('pointerup', touchPointer(5));
  assert.equal(up.defaultPrevented, true);
  assert.equal(btn.hasPointerCapture(5), false);
});

test('touch: pointerleave does not release if pointer is captured (thumb drift)', () => {
  const root = fakeTouchRoot(['left']);
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { touchRoot: root });
  const [btn] = root.buttons;

  btn.emit('pointerdown', touchPointer(3));
  assert.equal(btn.hasPointerCapture(3), true);
  input.poll(); // consume fresh press

  // Thumb drifts slightly outside the button boundary
  btn.emit('pointerleave', touchPointer(3));
  assert.equal(btn.classList.contains('is-pressed'), true, 'still pressed');

  // Release occurs when thumb is lifted
  btn.emit('pointerup', touchPointer(3));
  assert.equal(btn.classList.contains('is-pressed'), false);
  assert.equal(btn.hasPointerCapture(3), false);
});

test('touch: uncaptured pointerleave releases the button', () => {
  const root = fakeTouchRoot(['right']);
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { touchRoot: root });
  const [btn] = root.buttons;

  btn.emit('pointerdown', touchPointer(4));
  btn.releasePointerCapture(4); // simulate uncaptured pointer (e.g. mouse or unsupported)

  btn.emit('pointerleave', touchPointer(4));
  assert.equal(btn.classList.contains('is-pressed'), false);
  input.poll();
  assert.equal(input.poll().shift, 0);
});

test('touch: pointercancel releases the button and clears capture', () => {
  const root = fakeTouchRoot(['hardDrop']);
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { touchRoot: root });
  const [btn] = root.buttons;

  btn.emit('pointerdown', touchPointer(7));
  assert.equal(btn.hasPointerCapture(7), true);
  assert.equal(btn.classList.contains('is-pressed'), true);

  btn.emit('pointercancel', touchPointer(7));
  assert.equal(btn.hasPointerCapture(7), false);
  assert.equal(btn.classList.contains('is-pressed'), false);
});

test('touch: contextmenu is suppressed on virtual buttons', () => {
  const root = fakeTouchRoot(['hold']);
  const target = recordingTarget();
  createInput(target, undefined, undefined, { touchRoot: root });
  const [btn] = root.buttons;

  const e = btn.emit('contextmenu', { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  assert.equal(e.defaultPrevented, true);
});

test('touch: reset() clears all active touch pointers and pressed classes', () => {
  const root = fakeTouchRoot(['left', 'softDrop']);
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { touchRoot: root });
  const [btnLeft, btnDown] = root.buttons;

  btnLeft.emit('pointerdown', touchPointer(1));
  btnDown.emit('pointerdown', touchPointer(2));
  assert.equal(btnLeft.classList.contains('is-pressed'), true);
  assert.equal(btnDown.classList.contains('is-pressed'), true);

  input.reset();
  assert.equal(btnLeft.classList.contains('is-pressed'), false);
  assert.equal(btnDown.classList.contains('is-pressed'), false);
  assert.deepEqual(input.poll(), emptyActions());
});

test('touch: destroy() unbinds all touch listeners', () => {
  const root = fakeTouchRoot(['left', 'rotateCW']);
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { touchRoot: root });
  const [btn] = root.buttons;

  assert.equal(btn.count('pointerdown'), 1);
  assert.equal(btn.count('pointerup'), 1);
  assert.equal(btn.count('pointercancel'), 1);
  assert.equal(btn.count('pointerleave'), 1);
  assert.equal(btn.count('contextmenu'), 1);

  input.destroy();
  assert.equal(btn.count('pointerdown'), 0);
  assert.equal(btn.count('pointerup'), 0);
  assert.equal(btn.count('pointercancel'), 0);
  assert.equal(btn.count('pointerleave'), 0);
  assert.equal(btn.count('contextmenu'), 0);
});

test('touch: zero allocations - poll() reuses preallocated actions object', () => {
  const root = fakeTouchRoot(['left', 'rotateCW']);
  const input = createInput(recordingTarget(), undefined, undefined, { touchRoot: root });
  const a1 = input.poll();
  root.buttons[0].emit('pointerdown', touchPointer(1));
  const a2 = input.poll();
  assert.equal(a1, a2, 'poll() reuses the preallocated Actions instance');
  root.buttons[1].emit('pointerdown', touchPointer(2));
  const a3 = input.poll();
  assert.equal(a2, a3, 'poll() reuses the preallocated Actions instance with multi-touch');
});
