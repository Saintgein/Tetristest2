// ==========================================================================
//  src/input.js
//  Keyboard → per-frame Actions with our own DAS/ARR (SPEC §6.4).
//  Browser key-repeat is ignored; poll() is called once per 60 Hz step.
// ==========================================================================

import { KEY_BINDINGS, DAS_FRAMES, ARR_FRAMES } from './config.js';

/**
 * @typedef {Object} Actions
 * @property {-1|0|1}  shift
 * @property {boolean} shiftToWall
 * @property {boolean} softDrop
 * @property {boolean} hardDrop
 * @property {-1|0|1}  rotate
 * @property {boolean} hold
 * @property {boolean} pause
 * @property {boolean} start
 * @property {boolean} mute
 * @property {boolean} music
 * @property {-1|0|1}  menuX
 */

/** @returns {Actions} a no-input frame. */
export function emptyActions() {
  return {
    shift: 0,
    shiftToWall: false,
    softDrop: false,
    hardDrop: false,
    rotate: 0,
    hold: false,
    pause: false,
    start: false,
    mute: false,
    music: false,
    menuX: 0,
  };
}

/** @returns {{ dir: -1|0|1, frames: number }} */
export function createDasState() {
  return { dir: 0, frames: 0 };
}

/**
 * Advances DAS by one frame (mutates `das`).
 * @param {{ dir: number, frames: number }} das
 * @param {-1|0|1} dir resolved horizontal direction this frame
 * @param {boolean} fresh that direction had a press edge since the last poll
 * @returns {-1|0|1} horizontal shift to apply this frame
 */
export function stepDas(das, dir, fresh, dasFrames, arrFrames) {
  if (dir === 0) {
    das.dir = 0;
    das.frames = 0;
    return 0;
  }
  if (dir !== das.dir || fresh) {           // initial shift
    das.dir = dir;
    das.frames = 0;
    return dir;
  }
  das.frames++;
  if (das.frames < dasFrames) return 0;     // charging
  if (arrFrames === 0) return dir;          // poll() also sets shiftToWall
  return (das.frames - dasFrames) % arrFrames === 0 ? dir : 0;
}

/**
 * @param {EventTarget} target receives keydown / keyup / blur (window in the browser)
 * @param {Record<string, string[]>} bindings action → KeyboardEvent.code list
 * @param {{ dasFrames?: number, arrFrames?: number }} [timing]
 * @returns {{ poll(): Actions, reset(): void, destroy(): void }}
 */
export function createInput(
  target = window,
  bindings = KEY_BINDINGS,
  { dasFrames = DAS_FRAMES, arrFrames = ARR_FRAMES } = {},
) {
  // Everything below is preallocated: key handling and poll() never allocate
  // (Set add/delete/clear churn their backing tables in V8).
  const actionNames = Object.keys(bindings);
  const codeToAction = new Map();
  const codeDown = new Map();               // physical key → down? (aliases don't release each other)
  const heldCount = {};                     // action → number of its keys held
  const pressed = {};                       // action → press edge since last poll
  for (const action of actionNames) {
    heldCount[action] = 0;
    pressed[action] = false;
    for (const code of bindings[action]) {
      codeToAction.set(code, action);
      codeDown.set(code, false);
    }
  }
  let anyPressed = false;

  const actions = emptyActions();           // reused by poll()
  const das = createDasState();
  let lastHorizontal = 0;

  const isHeld = (action) => heldCount[action] > 0;
  const isPressed = (action) => pressed[action] === true;
  const isActive = (action) => isHeld(action) || isPressed(action);

  function onKeyDown(e) {
    const action = codeToAction.get(e.code);
    if (action === undefined) return;
    e.preventDefault();
    if (e.repeat || codeDown.get(e.code)) return;
    codeDown.set(e.code, true);
    heldCount[action]++;
    if (heldCount[action] > 1) return;      // another alias already holds it: not a new press
    pressed[action] = true;
    anyPressed = true;
    if (action === 'left') lastHorizontal = -1;
    else if (action === 'right') lastHorizontal = 1;
  }

  function onKeyUp(e) {
    const action = codeToAction.get(e.code);
    if (action === undefined) return;
    e.preventDefault();
    if (!codeDown.get(e.code)) return;      // e.g. released after a blur reset
    codeDown.set(e.code, false);
    heldCount[action]--;
  }

  function clearPressed() {
    for (let i = 0; i < actionNames.length; i++) pressed[actionNames[i]] = false;
    anyPressed = false;
  }

  function reset() {
    for (const code of codeDown.keys()) codeDown.set(code, false);
    for (const action of actionNames) heldCount[action] = 0;
    clearPressed();
    lastHorizontal = 0;
    das.dir = 0;
    das.frames = 0;
  }

  function resolveHorizontal(left, right) {
    if (left && right) return lastHorizontal;
    return left ? -1 : right ? 1 : 0;
  }

  function poll() {
    const dir = resolveHorizontal(isActive('left'), isActive('right'));
    const fresh = dir !== 0 && isPressed(dir < 0 ? 'left' : 'right');
    const shift = stepDas(das, dir, fresh, dasFrames, arrFrames);

    // One Actions object, overwritten every poll (no per-frame allocation).
    // Callers must read it before the next poll; copy it to keep a snapshot.
    actions.shift = shift;
    actions.shiftToWall = arrFrames === 0 && shift !== 0 && das.frames >= dasFrames;
    actions.softDrop = isActive('softDrop');
    actions.hardDrop = isPressed('hardDrop');
    actions.rotate = isPressed('rotateCW') ? 1 : isPressed('rotateCCW') ? -1 : 0;
    actions.hold = isPressed('hold');
    actions.pause = isPressed('pause');
    actions.start = isPressed('start');
    actions.mute = isPressed('mute');
    actions.music = isPressed('music');
    actions.menuX = resolveHorizontal(isPressed('left'), isPressed('right'));
    if (anyPressed) clearPressed();
    return actions;
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', reset);

  return {
    poll,
    reset,
    destroy() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', reset);
    },
  };
}
