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
  const codeToAction = new Map();
  // Held state is tracked per physical key so aliases (ArrowLeft + KeyA) don't
  // release each other.
  const heldCodes = new Map();              // action → Set<code>
  for (const [action, codes] of Object.entries(bindings)) {
    heldCodes.set(action, new Set());
    for (const code of codes) codeToAction.set(code, action);
  }

  const pressed = new Set();                // actions with a press edge since last poll
  let lastHorizontal = 0;
  let das = createDasState();

  const isHeld = (action) => heldCodes.get(action)?.size > 0;
  const isActive = (action) => isHeld(action) || pressed.has(action);

  function onKeyDown(e) {
    const action = codeToAction.get(e.code);
    if (action === undefined) return;
    e.preventDefault();
    if (e.repeat) return;
    const codes = heldCodes.get(action);
    if (codes.has(e.code)) return;
    const wasHeld = codes.size > 0;
    codes.add(e.code);
    if (wasHeld) return;
    pressed.add(action);
    if (action === 'left') lastHorizontal = -1;
    else if (action === 'right') lastHorizontal = 1;
  }

  function onKeyUp(e) {
    const action = codeToAction.get(e.code);
    if (action === undefined) return;
    e.preventDefault();
    heldCodes.get(action).delete(e.code);
  }

  function reset() {
    for (const codes of heldCodes.values()) codes.clear();
    pressed.clear();
    lastHorizontal = 0;
    das = createDasState();
  }

  function resolveHorizontal(left, right) {
    if (left && right) return lastHorizontal;
    return left ? -1 : right ? 1 : 0;
  }

  function poll() {
    const dir = resolveHorizontal(isActive('left'), isActive('right'));
    const fresh = dir !== 0 && pressed.has(dir < 0 ? 'left' : 'right');
    const shift = stepDas(das, dir, fresh, dasFrames, arrFrames);

    const actions = {
      shift,
      shiftToWall: arrFrames === 0 && shift !== 0 && das.frames >= dasFrames,
      softDrop: isActive('softDrop'),
      hardDrop: pressed.has('hardDrop'),
      rotate: pressed.has('rotateCW') ? 1 : pressed.has('rotateCCW') ? -1 : 0,
      hold: pressed.has('hold'),
      pause: pressed.has('pause'),
      start: pressed.has('start'),
      mute: pressed.has('mute'),
      menuX: resolveHorizontal(pressed.has('left'), pressed.has('right')),
    };
    pressed.clear();
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
