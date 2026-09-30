import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyActions, createDasState, stepDas, createInput, GP_AXIS_DEADZONE } from '../src/input.js';
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

// ---------- Gamepad API Controller Support ----------

function fakeGamepad({
  connected = true,
  axes = [0, 0, 0, 0],
  buttons = [],
} = {}) {
  const btnObjs = [];
  for (let i = 0; i < 17; i++) {
    const b = buttons[i];
    if (b !== undefined) {
      if (typeof b === 'object' && b !== null) btnObjs.push({ pressed: b.pressed ?? false, value: b.value ?? 0 });
      else if (typeof b === 'boolean') btnObjs.push({ pressed: b, value: b ? 1 : 0 });
      else btnObjs.push({ pressed: b > 0.5, value: Number(b) });
    } else {
      btnObjs.push({ pressed: false, value: 0 });
    }
  }
  return { connected, axes: [...axes], buttons: btnObjs };
}

test('gamepad: empty or null gamepads list returns default empty actions', () => {
  let pads = [];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });
  assert.deepEqual({ ...input.poll() }, emptyActions());

  pads = null;
  assert.deepEqual({ ...input.poll() }, emptyActions());

  pads = [null, null, null, null];
  assert.deepEqual({ ...input.poll() }, emptyActions());
});

test('gamepad: deadzone constant is 0.5', () => {
  assert.equal(GP_AXIS_DEADZONE, 0.5);
});

test('gamepad: D-Pad Left and Right trigger horizontal shift and DAS/ARR repeats', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, { dasFrames: 10, arrFrames: 2 }, { getGamepads: () => pads });

  // Hold D-Pad Left (Button 14) for 20 frames
  pads = [fakeGamepad({ buttons: { 14: true } })];

  const shifts = [];
  for (let i = 0; i < 20; i++) {
    const { shift } = input.poll();
    if (shift !== 0) shifts.push([i, shift]);
  }
  // Frame 0: fresh shift (-1)
  // Frames 1..9: charging DAS (10 frames)
  // Frame 10: DAS fires (-1)
  // Frames 12, 14, 16, 18: ARR repeats (-1)
  assert.deepEqual(shifts, [[0, -1], [10, -1], [12, -1], [14, -1], [16, -1], [18, -1]]);

  // Release D-Pad Left
  pads = [fakeGamepad()];
  assert.equal(input.poll().shift, 0);

  // Tap D-Pad Right (Button 15)
  pads = [fakeGamepad({ buttons: { 15: true } })];
  assert.equal(input.poll().shift, 1);
  pads = [fakeGamepad()];
  assert.equal(input.poll().shift, 0);
});

test('gamepad: Left Stick X triggers horizontal shift and respects 0.5 deadzone', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, { dasFrames: 10, arrFrames: 2 }, { getGamepads: () => pads });

  // Within deadzone (-0.49 and +0.49)
  pads = [fakeGamepad({ axes: [-0.49, 0] })];
  assert.equal(input.poll().shift, 0);

  pads = [fakeGamepad({ axes: [0.49, 0] })];
  assert.equal(input.poll().shift, 0);

  // At/beyond deadzone threshold (-0.5): triggers Left
  pads = [fakeGamepad({ axes: [-0.5, 0] })];
  assert.equal(input.poll().shift, -1);

  // Neutralize stick
  pads = [fakeGamepad({ axes: [0, 0] })];
  assert.equal(input.poll().shift, 0);

  // At/beyond deadzone threshold (+0.5): triggers Right
  pads = [fakeGamepad({ axes: [0.5, 0] })];
  assert.equal(input.poll().shift, 1);
});

test('gamepad: D-Pad Down and Left Stick Y trigger Soft Drop while held', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  // D-Pad Down (Button 13) held
  pads = [fakeGamepad({ buttons: { 13: true } })];
  assert.equal(input.poll().softDrop, true);
  assert.equal(input.poll().softDrop, true);

  // Released
  pads = [fakeGamepad()];
  assert.equal(input.poll().softDrop, false);

  // Left Stick Y inside deadzone (< 0.5)
  pads = [fakeGamepad({ axes: [0, 0.49] })];
  assert.equal(input.poll().softDrop, false);

  // Left Stick Y at threshold (0.5)
  pads = [fakeGamepad({ axes: [0, 0.5] })];
  assert.equal(input.poll().softDrop, true);

  // Left Stick Y full down (1.0)
  pads = [fakeGamepad({ axes: [0, 1.0] })];
  assert.equal(input.poll().softDrop, true);

  // Neutralize
  pads = [fakeGamepad({ axes: [0, 0] })];
  assert.equal(input.poll().softDrop, false);
});

test('gamepad: D-Pad Up triggers Hard Drop as single-frame edge', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  // D-Pad Up (Button 12) pressed
  pads = [fakeGamepad({ buttons: { 12: true } })];
  assert.equal(input.poll().hardDrop, true, 'poll 0: edge detected');
  assert.equal(input.poll().hardDrop, false, 'poll 1: held does not re-trigger');

  // Released and re-pressed
  pads = [fakeGamepad()];
  input.poll();
  pads = [fakeGamepad({ buttons: { 12: true } })];
  assert.equal(input.poll().hardDrop, true, 'poll 3: fresh press triggers again');
});

test('gamepad: Buttons 0 and 3 trigger Rotate CW (A / Cross, Y / Triangle) as single-frame edges', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  // Button 0 (A)
  pads = [fakeGamepad({ buttons: { 0: true } })];
  assert.equal(input.poll().rotate, 1);
  assert.equal(input.poll().rotate, 0);

  // Release
  pads = [fakeGamepad()];
  input.poll();

  // Button 3 (Y)
  pads = [fakeGamepad({ buttons: { 3: true } })];
  assert.equal(input.poll().rotate, 1);
  assert.equal(input.poll().rotate, 0);
});

test('gamepad: Buttons 1 and 2 trigger Rotate CCW (B / Circle, X / Square) as single-frame edges', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  // Button 1 (B)
  pads = [fakeGamepad({ buttons: { 1: true } })];
  assert.equal(input.poll().rotate, -1);
  assert.equal(input.poll().rotate, 0);

  // Release
  pads = [fakeGamepad()];
  input.poll();

  // Button 2 (X)
  pads = [fakeGamepad({ buttons: { 2: true } })];
  assert.equal(input.poll().rotate, -1);
  assert.equal(input.poll().rotate, 0);
});

test('gamepad: Bumpers (4, 5) and Triggers (6, 7) trigger Hold as single-frame edge', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  // Left Bumper (4)
  pads = [fakeGamepad({ buttons: { 4: true } })];
  assert.equal(input.poll().hold, true);
  assert.equal(input.poll().hold, false);

  // Release
  pads = [fakeGamepad()];
  input.poll();

  // Right Bumper (5)
  pads = [fakeGamepad({ buttons: { 5: true } })];
  assert.equal(input.poll().hold, true);
  assert.equal(input.poll().hold, false);

  // Release
  pads = [fakeGamepad()];
  input.poll();

  // Left Trigger (6) with analog value > 0.5
  pads = [fakeGamepad({ buttons: { 6: { pressed: true, value: 0.8 } } })];
  assert.equal(input.poll().hold, true);
  assert.equal(input.poll().hold, false);

  // Release
  pads = [fakeGamepad()];
  input.poll();

  // Right Trigger (7) with analog value > 0.5
  pads = [fakeGamepad({ buttons: { 7: 0.9 } })];
  assert.equal(input.poll().hold, true);
  assert.equal(input.poll().hold, false);
});

test('gamepad: Start / Options (Button 9) triggers Pause and Start as single-frame edges', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  pads = [fakeGamepad({ buttons: { 9: true } })];
  const a = input.poll();
  assert.equal(a.pause, true);
  assert.equal(a.start, true);

  const held = input.poll();
  assert.equal(held.pause, false);
  assert.equal(held.start, false);
});

test('gamepad: Button 0 (A) triggers Start as single-frame edge for title and game-over', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  pads = [fakeGamepad({ buttons: { 0: true } })];
  const a = input.poll();
  assert.equal(a.start, true);
  assert.equal(a.rotate, 1);

  const held = input.poll();
  assert.equal(held.start, false);
  assert.equal(held.rotate, 0);
});

test('gamepad: D-Pad Left/Right and Left Stick X adjust menuX on title screen', () => {
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  // D-Pad Left
  pads = [fakeGamepad({ buttons: { 14: true } })];
  assert.equal(input.poll().menuX, -1);
  assert.equal(input.poll().menuX, 0, 'menuX is edge-based');

  // D-Pad Right
  pads = [fakeGamepad({ buttons: { 15: true } })];
  assert.equal(input.poll().menuX, 1);
  assert.equal(input.poll().menuX, 0);

  // Left Stick Left (axes[0] = -0.8)
  pads = [fakeGamepad({ axes: [-0.8, 0] })];
  assert.equal(input.poll().menuX, -1);
  assert.equal(input.poll().menuX, 0);

  // Left Stick Right (axes[0] = 0.8)
  pads = [fakeGamepad({ axes: [0.8, 0] })];
  assert.equal(input.poll().menuX, 1);
  assert.equal(input.poll().menuX, 0);
});

test('gamepad: multi-controller support and disconnected controller handling', () => {
  // Controller in slot 1 works even if slot 0 is null
  let pads = [null, fakeGamepad({ buttons: { 0: true } })];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });
  assert.equal(input.poll().rotate, 1);

  // Disconnected controller (connected = false) is ignored
  pads = [fakeGamepad({ connected: false, buttons: { 0: true } })];
  assert.equal(input.poll().rotate, 0);

  // Two connected controllers combined: pad 0 holds Soft Drop, pad 1 presses Rotate CW
  pads = [
    fakeGamepad({ buttons: { 13: true } }),
    fakeGamepad({ buttons: { 0: true } }),
  ];
  const both = input.poll();
  assert.equal(both.softDrop, true);
  assert.equal(both.rotate, 1);
});

test('gamepad: onGamepadButton callback fires on rising edge for audio unlock', () => {
  let buttonPresses = 0;
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, {
    getGamepads: () => pads,
    onGamepadButton: () => { buttonPresses++; },
  });

  // No buttons pressed
  input.poll();
  assert.equal(buttonPresses, 0);

  // Button 0 pressed
  pads = [fakeGamepad({ buttons: { 0: true } })];
  input.poll();
  assert.equal(buttonPresses, 1);

  // Button 0 still held
  input.poll();
  assert.equal(buttonPresses, 1);

  // Released
  pads = [fakeGamepad()];
  input.poll();
  assert.equal(buttonPresses, 1);

  // Button 9 pressed
  pads = [fakeGamepad({ buttons: { 9: true } })];
  input.poll();
  assert.equal(buttonPresses, 2);
});

test('gamepad: a polled button press is not reported as a DOM user gesture', () => {
  let gestures = 0;
  let buttonPresses = 0;
  let pads = [fakeGamepad()];
  const input = createInput(recordingTarget(), undefined, undefined, {
    getGamepads: () => pads,
    onGamepadButton: () => { buttonPresses++; },
    onUserGesture: () => { gestures++; },
  });
  input.poll();
  pads = [fakeGamepad({ buttons: { 9: true } })];
  input.poll();
  assert.equal(buttonPresses, 1);
  assert.equal(gestures, 0, 'rAF polling carries no user activation');
});

test('gamepad: reset() clears all gamepad state and cancels held inputs', () => {
  let pads = [fakeGamepad({ buttons: { 13: true, 14: true } })];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  input.poll(); // read held inputs
  pads = [fakeGamepad()];
  input.reset();

  assert.deepEqual({ ...input.poll() }, emptyActions());
});

test('gamepad: zero allocations during polling with active controller inputs', () => {
  let pads = [fakeGamepad({ axes: [-1, 0.6], buttons: { 0: true, 13: true } })];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  const a1 = input.poll();
  const a2 = input.poll();
  assert.equal(a1, a2, 'poll() reuses the preallocated Actions instance');
  pads = [fakeGamepad({ axes: [1, 0], buttons: { 1: true, 12: true } })];
  const a3 = input.poll();
  assert.equal(a2, a3, 'poll() continues reusing the preallocated Actions instance');
});

test('audio unlock: keyboard keydown on desktop triggers onUserGesture and transitions AudioContext to running', () => {
  let resumed = false;
  let unlocked = false;
  const mockContext = {
    state: 'suspended',
    resume() {
      this.state = 'running';
      resumed = true;
      return Promise.resolve();
    },
  };
  const mockAudio = {
    unlock() {
      unlocked = true;
      if (mockContext.state === 'suspended') mockContext.resume();
    },
  };

  const target = fakeTarget();
  createInput(target, undefined, undefined, {
    onUserGesture: () => mockAudio.unlock(),
  });

  assert.equal(mockContext.state, 'suspended');

  // Verify Enter, Space, NumpadEnter, and directional keys invoke unlock and transition AudioContext to running
  const testKeys = ['Enter', 'Space', 'NumpadEnter', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'];
  for (const code of testKeys) {
    mockContext.state = 'suspended';
    resumed = false;
    unlocked = false;
    target.emit('keydown', keyEvent(code));
    assert.equal(unlocked, true, `key ${code} should call unlock`);
    assert.equal(resumed, true, `key ${code} should resume AudioContext`);
    assert.equal(mockContext.state, 'running', `key ${code} should transition state to running`);
  }
});

test('pause rising edge: holding KeyP for multiple ticks toggles pause exactly once until released and pressed again', () => {
  const target = fakeTarget();
  const input = createInput(target);

  // Tick 0: KeyP down
  target.emit('keydown', keyEvent('KeyP'));
  const a0 = input.poll();
  assert.equal(a0.pause, true, 'tick 0: pause triggers on initial press');

  // Simulate phase change reset that happens in game loop
  input.reset();

  // Tick 1: KeyP still held
  const a1 = input.poll();
  assert.equal(a1.pause, false, 'tick 1: pause does NOT trigger while held');

  // Tick 2: KeyP still held (OS key-repeat simulation)
  target.emit('keydown', keyEvent('KeyP', true));
  const a2 = input.poll();
  assert.equal(a2.pause, false, 'tick 2: repeat keydown ignored while held');

  // Tick 3: Key released
  target.emit('keyup', keyEvent('KeyP'));
  const a3 = input.poll();
  assert.equal(a3.pause, false, 'tick 3: pause does NOT trigger on keyup');

  // Tick 4: Key pressed again (unpause toggle)
  target.emit('keydown', keyEvent('KeyP'));
  const a4 = input.poll();
  assert.equal(a4.pause, true, 'tick 4: pause triggers on new press after release');

  // Tick 5: Still held after unpause
  input.reset();
  const a5 = input.poll();
  assert.equal(a5.pause, false, 'tick 5: pause does NOT trigger while held after unpause');
});

test('pause rising edge: holding Escape for multiple ticks toggles pause exactly once until released and pressed again', () => {
  const target = fakeTarget();
  const input = createInput(target);

  // Tick 0: Escape down
  target.emit('keydown', keyEvent('Escape'));
  assert.equal(input.poll().pause, true, 'initial press fires pause');

  // Phase transition reset
  input.reset();
  assert.equal(input.poll().pause, false, 'consecutive tick 1 while held ignores pause');
  assert.equal(input.poll().pause, false, 'consecutive tick 2 while held ignores pause');

  // Release
  target.emit('keyup', keyEvent('Escape'));
  assert.equal(input.poll().pause, false, 'keyup frame produces no pause');

  // Press again
  target.emit('keydown', keyEvent('Escape'));
  assert.equal(input.poll().pause, true, 'second press triggers pause toggle');
});

test('pause rising edge: holding Gamepad Button 9 for multiple ticks toggles pause exactly once until released and pressed again', () => {
  let pads = [fakeGamepad({ buttons: { 9: true } })];
  const input = createInput(recordingTarget(), undefined, undefined, { getGamepads: () => pads });

  // Tick 0: Button 9 down
  const a0 = input.poll();
  assert.equal(a0.pause, true, 'tick 0: Gamepad Button 9 triggers pause');

  // Phase transition reset
  input.reset();

  // Tick 1: Button 9 still held
  const a1 = input.poll();
  assert.equal(a1.pause, false, 'tick 1: Gamepad Button 9 held does not trigger pause');

  // Tick 2: Button 9 still held
  input.reset();
  const a2 = input.poll();
  assert.equal(a2.pause, false, 'tick 2: Gamepad Button 9 held does not trigger pause');

  // Tick 3: Button 9 released
  pads = [fakeGamepad()];
  const a3 = input.poll();
  assert.equal(a3.pause, false, 'tick 3: release does not trigger pause');

  // Tick 4: Button 9 pressed again
  pads = [fakeGamepad({ buttons: { 9: true } })];
  const a4 = input.poll();
  assert.equal(a4.pause, true, 'tick 4: Gamepad Button 9 press again triggers pause toggle');

  // Tick 5: Button 9 still held
  input.reset();
  const a5 = input.poll();
  assert.equal(a5.pause, false, 'tick 5: held does not trigger pause');
});

test('pause rising edge: holding touch PAUSE button for multiple ticks toggles pause exactly once until released and pressed again', () => {
  const root = fakeTouchRoot(['pause']);
  const target = recordingTarget();
  const input = createInput(target, undefined, undefined, { touchRoot: root });
  const [btnPause] = root.buttons;

  // Touch pointerdown
  btnPause.emit('pointerdown', touchPointer(1));
  const a0 = input.poll();
  assert.equal(a0.pause, true, 'tick 0: touch PAUSE triggers pause');

  // Phase transition reset
  input.reset();

  // Touch still held
  const a1 = input.poll();
  assert.equal(a1.pause, false, 'tick 1: touch PAUSE held does not trigger pause');

  const a2 = input.poll();
  assert.equal(a2.pause, false, 'tick 2: touch PAUSE held does not trigger pause');

  // Touch released
  btnPause.emit('pointerup', touchPointer(1));
  const a3 = input.poll();
  assert.equal(a3.pause, false, 'tick 3: release does not trigger pause');

  // Touch pressed again
  btnPause.emit('pointerdown', touchPointer(2));
  const a4 = input.poll();
  assert.equal(a4.pause, true, 'tick 4: touch pressed again triggers pause toggle');
});
