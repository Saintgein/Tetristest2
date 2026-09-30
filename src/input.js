// ==========================================================================
//  src/input.js
//  Keyboard → per-frame Actions with our own DAS/ARR (SPEC §6.4).
//  Browser key-repeat is ignored; poll() is called once per 60 Hz step.
// ==========================================================================

import { KEY_BINDINGS, KEY_FALLBACKS, DAS_FRAMES, ARR_FRAMES } from './config.js';

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

export const GP_AXIS_DEADZONE = 0.5;

const GP_LEFT = 0;
const GP_RIGHT = 1;
const GP_SOFT_DROP = 2;
const GP_HARD_DROP = 3;
const GP_ROTATE_CW = 4;
const GP_ROTATE_CCW = 5;
const GP_HOLD = 6;
const GP_PAUSE = 7;
const GP_START = 8;
const GP_ACTION_COUNT = 9;

function isGamepadButtonDown(btn) {
  if (!btn) return false;
  if (typeof btn === 'object') {
    return btn.pressed === true || btn.value > 0.5;
  }
  return btn > 0.5;
}

/** Keys are handled in the capture phase and never passively, so nothing on the page can swallow them first. */
const KEY_LISTENER_OPTIONS = { capture: true, passive: false };
const POINTER_LISTENER_OPTIONS = { capture: true, passive: true };
const NON_START_TARGETS = 'button, a, input, select, textarea, [data-no-start]';

/**
 * @param {EventTarget} target receives keydown / keyup / blur / pointerdown (window in the browser)
 * @param {Record<string, string[]>} bindings action → KeyboardEvent.code list
 * @param {{ dasFrames?: number, arrFrames?: number }} [timing]
 * @param {{ keyFallbacks?: Record<string, string>, pointerStart?: boolean, touchRoot?: Element|null, getGamepads?: (() => (Gamepad|null)[])|null, onGamepadButton?: (() => void)|null, onUserGesture?: ((e?: Event) => void)|null }} [options]
 *        keyFallbacks: KeyboardEvent.key → action when the code is empty/unbound;
 *        pointerStart: a primary click/tap anywhere (except controls) presses Start;
 *        touchRoot: container element with [data-action] virtual buttons;
 *        getGamepads: accessor returning gamepads list (defaults to navigator.getGamepads);
 *        onGamepadButton: callback fired on controller button press (used for audio unlock);
 *        onUserGesture: callback fired on any user input gesture (used for audio unlock)
 * @returns {{ poll(): Actions, press(action: string): void, reset(): void, destroy(): void, bindTouch(element: Element): void }}
 */
export function createInput(
  target = window,
  bindings = KEY_BINDINGS,
  { dasFrames = DAS_FRAMES, arrFrames = ARR_FRAMES } = {},
  {
    keyFallbacks = KEY_FALLBACKS,
    pointerStart = true,
    touchRoot = null,
    getGamepads = null,
    onGamepadButton = null,
    onUserGesture = null,
  } = {},
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

  // Strict rising-edge tracking for pause across keyboard, touch and gamepad
  const pausePhysicalKeysDown = new Set();
  const touchPausePointers = new Set();
  let pauseLocked = false;

  // Preallocated multi-touch tracking for virtual buttons (up to 16 concurrent touch points).
  // Strictly zero allocations during touch events and game poll ticks.
  const MAX_TOUCH_POINTERS = 16;
  const activePointerIds = new Int32Array(MAX_TOUCH_POINTERS);
  const activePointerActions = new Array(MAX_TOUCH_POINTERS);
  const activePointerElements = new Array(MAX_TOUCH_POINTERS);
  activePointerIds.fill(-1);
  for (let i = 0; i < MAX_TOUCH_POINTERS; i++) {
    activePointerActions[i] = '';
    activePointerElements[i] = null;
  }
  const boundButtons = [];

  // Preallocated Gamepad API tracking. Strictly zero allocations during polling.
  const gamepadCurrent = new Uint8Array(GP_ACTION_COUNT);
  const gamepadPrevious = new Uint8Array(GP_ACTION_COUNT);
  let gamepadButtonWasDown = false;

  const queryGamepads = typeof getGamepads === 'function'
    ? getGamepads
    : () => {
        try {
          return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
            ? navigator.getGamepads()
            : null;
        } catch {
          return null;
        }
      };

  // key → { action, id }: the id stands in for the missing code in codeDown
  const fallbackByKey = new Map();
  for (const [key, action] of Object.entries(keyFallbacks)) {
    if (!(action in pressed)) continue;
    const id = `key:${key}`;
    fallbackByKey.set(key, { action, id });
    codeDown.set(id, false);
  }
  const hit = { action: '', id: '' };       // scratch result of resolve()
  let anyPressed = false;

  /** Finds the action for a key event: by code, else by named-key fallback. */
  function resolve(e) {
    const byCode = codeToAction.get(e.code);
    if (byCode !== undefined) {
      hit.action = byCode;
      hit.id = e.code;
      return true;
    }
    const fallback = fallbackByKey.get(e.key);
    if (fallback === undefined) return false;
    hit.action = fallback.action;
    hit.id = fallback.id;
    return true;
  }

  const actions = emptyActions();           // reused by poll()
  const das = createDasState();
  let lastHorizontal = 0;

  const isHeld = (action) => heldCount[action] > 0;
  const isPressed = (action) => pressed[action] === true;
  const isActive = (action) => isHeld(action) || isPressed(action);

  function onKeyDown(e) {
    if (typeof onUserGesture === 'function') onUserGesture(e);
    if (e.isComposing || e.keyCode === 229) return;   // IME composing: the key belongs to the text
    if (!resolve(e)) return;
    const { action, id } = hit;
    e.preventDefault();                     // keep the browser from scrolling / clicking with game keys
    if (action === 'pause') {
      pausePhysicalKeysDown.add(id);
    }
    if (e.repeat || codeDown.get(id)) return;
    codeDown.set(id, true);
    heldCount[action]++;
    if (heldCount[action] > 1) return;      // another alias already holds it: not a new press
    press(action);
    if (action === 'left') lastHorizontal = -1;
    else if (action === 'right') lastHorizontal = 1;
  }

  function onKeyUp(e) {
    if (!resolve(e)) return;
    const { action, id } = hit;
    e.preventDefault();
    if (action === 'pause') {
      pausePhysicalKeysDown.delete(id);
    }
    if (!codeDown.get(id)) return;          // e.g. released after a blur reset
    codeDown.set(id, false);
    heldCount[action]--;
  }

  /** A press edge without a held key (clicks, taps, tests). */
  function press(action) {
    if (!(action in pressed)) return;
    pressed[action] = true;
    anyPressed = true;
  }

  /** Click / tap anywhere presses Start, e.g. when the page doesn't have keyboard focus. */
  function onPointerDown(e) {
    if (typeof onUserGesture === 'function') onUserGesture(e);
    if (e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (typeof e.target?.closest === 'function' && e.target.closest(NON_START_TARGETS)) return;
    press('start');
  }

  function clearPressed() {
    for (let i = 0; i < actionNames.length; i++) pressed[actionNames[i]] = false;
    anyPressed = false;
  }

  function reset() {
    for (const code of codeDown.keys()) {
      if (pausePhysicalKeysDown.has(code)) continue;
      codeDown.set(code, false);
    }
    for (const action of actionNames) {
      if (action === 'pause' && (pausePhysicalKeysDown.size > 0 || touchPausePointers.size > 0)) {
        heldCount[action] = 1;
        continue;
      }
      heldCount[action] = 0;
    }
    for (let i = 0; i < MAX_TOUCH_POINTERS; i++) {
      const el = activePointerElements[i];
      const pid = activePointerIds[i];
      const action = activePointerActions[i];
      if (action === 'pause' && touchPausePointers.has(pid)) {
        continue;
      }
      if (el) {
        el.classList?.remove?.('is-pressed');
        try {
          if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(pid)) {
            el.releasePointerCapture(pid);
          }
        } catch { /* ignore */ }
      }
      activePointerIds[i] = -1;
      activePointerActions[i] = '';
      activePointerElements[i] = null;
    }
    gamepadCurrent.fill(0);
    gamepadPrevious.fill(0);
    gamepadButtonWasDown = false;
    clearPressed();
    lastHorizontal = 0;
    das.dir = 0;
    das.frames = 0;
  }

  // -------------------------------------------------------------------------
  // Virtual touch controls: Pointer Events with setPointerCapture (zero-alloc)
  // -------------------------------------------------------------------------

  function onTouchButtonPointerDown(e) {
    if (typeof onUserGesture === 'function') onUserGesture(e);
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const btn = e.currentTarget || e.target;
    const action = btn?.getAttribute?.('data-action') ?? btn?.dataset?.action;
    if (!action || !(action in pressed)) return;

    if (action === 'pause') {
      touchPausePointers.add(e.pointerId);
    }

    e.preventDefault?.();

    try {
      if (typeof btn.setPointerCapture === 'function') {
        btn.setPointerCapture(e.pointerId);
      }
    } catch { /* ignore unsupported capture */ }

    let slot = -1;
    let emptySlot = -1;
    for (let i = 0; i < MAX_TOUCH_POINTERS; i++) {
      if (activePointerIds[i] === e.pointerId) {
        slot = i;
        break;
      }
      if (emptySlot === -1 && activePointerIds[i] === -1) {
        emptySlot = i;
      }
    }

    if (slot !== -1) {
      const oldAction = activePointerActions[slot];
      if (oldAction !== action) {
        if (oldAction === 'pause') {
          touchPausePointers.delete(e.pointerId);
        }
        heldCount[oldAction]--;
        if (heldCount[oldAction] < 0) heldCount[oldAction] = 0;
        activePointerActions[slot] = action;
        activePointerElements[slot] = btn;
        heldCount[action]++;
        if (heldCount[action] === 1) {
          press(action);
          if (action === 'left') lastHorizontal = -1;
          else if (action === 'right') lastHorizontal = 1;
        }
      }
    } else if (emptySlot !== -1) {
      activePointerIds[emptySlot] = e.pointerId;
      activePointerActions[emptySlot] = action;
      activePointerElements[emptySlot] = btn;
      heldCount[action]++;
      if (heldCount[action] === 1) {
        press(action);
        if (action === 'left') lastHorizontal = -1;
        else if (action === 'right') lastHorizontal = 1;
      }
    }

    btn.classList?.add?.('is-pressed');
  }

  function releasePointerSlot(pointerId, targetElement) {
    touchPausePointers.delete(pointerId);
    for (let i = 0; i < MAX_TOUCH_POINTERS; i++) {
      if (activePointerIds[i] === pointerId) {
        const action = activePointerActions[i];
        const el = activePointerElements[i] || targetElement;
        activePointerIds[i] = -1;
        activePointerActions[i] = '';
        activePointerElements[i] = null;

        if (el) {
          el.classList?.remove?.('is-pressed');
          try {
            if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(pointerId)) {
              el.releasePointerCapture(pointerId);
            }
          } catch { /* ignore */ }
        }

        if (action && action in heldCount) {
          heldCount[action]--;
          if (heldCount[action] < 0) heldCount[action] = 0;
        }
        break;
      }
    }
  }

  function onTouchButtonPointerUp(e) {
    e.preventDefault?.();
    releasePointerSlot(e.pointerId, e.currentTarget || e.target);
  }

  function onTouchButtonPointerCancel(e) {
    e.preventDefault?.();
    touchPausePointers.delete(e.pointerId);
    releasePointerSlot(e.pointerId, e.currentTarget || e.target);
  }

  function onTouchButtonPointerLeave(e) {
    const btn = e.currentTarget || e.target;
    try {
      if (typeof btn?.hasPointerCapture === 'function' && btn.hasPointerCapture(e.pointerId)) {
        return; // Pointer captured: thumb sliding slightly outside button boundary is still holding it
      }
    } catch { /* ignore */ }

    releasePointerSlot(e.pointerId, btn);
  }

  function onTouchContextMenu(e) {
    e.preventDefault?.();
  }

  function unbindTouch() {
    for (let i = 0; i < boundButtons.length; i++) {
      const btn = boundButtons[i];
      btn.removeEventListener?.('pointerdown', onTouchButtonPointerDown);
      btn.removeEventListener?.('pointerup', onTouchButtonPointerUp);
      btn.removeEventListener?.('pointercancel', onTouchButtonPointerCancel);
      btn.removeEventListener?.('pointerleave', onTouchButtonPointerLeave);
      btn.removeEventListener?.('contextmenu', onTouchContextMenu);
    }
    boundButtons.length = 0;
  }

  function bindTouch(root) {
    if (!root) return;
    unbindTouch();
    const list = typeof root.querySelectorAll === 'function'
      ? root.querySelectorAll('[data-action]')
      : [];
    const elements = list && list.length > 0
      ? Array.from(list)
      : (typeof root.getAttribute === 'function' && root.getAttribute('data-action') ? [root] : []);

    for (let i = 0; i < elements.length; i++) {
      const btn = elements[i];
      btn.addEventListener?.('pointerdown', onTouchButtonPointerDown);
      btn.addEventListener?.('pointerup', onTouchButtonPointerUp);
      btn.addEventListener?.('pointercancel', onTouchButtonPointerCancel);
      btn.addEventListener?.('pointerleave', onTouchButtonPointerLeave);
      btn.addEventListener?.('contextmenu', onTouchContextMenu);
      boundButtons.push(btn);
    }
  }

  if (touchRoot) {
    bindTouch(touchRoot);
  }

  function resolveHorizontal(left, right) {
    if (left && right) return lastHorizontal;
    return left ? -1 : right ? 1 : 0;
  }

  function poll() {
    gamepadCurrent.fill(0);
    let anyGamepadButtonDown = false;

    let gamepads = null;
    try {
      gamepads = queryGamepads ? queryGamepads() : null;
    } catch {
      gamepads = null;
    }

    if (gamepads) {
      const gpCount = gamepads.length;
      for (let i = 0; i < gpCount; i++) {
        const gp = gamepads[i];
        if (!gp || gp.connected === false) continue;

        const btns = gp.buttons;
        const axes = gp.axes;

        if (btns) {
          const bLen = btns.length;
          for (let b = 0; b < bLen; b++) {
            if (isGamepadButtonDown(btns[b])) {
              anyGamepadButtonDown = true;
              break;
            }
          }
        }

        const axisX = axes && axes.length > 0 ? axes[0] : 0;
        const axisY = axes && axes.length > 1 ? axes[1] : 0;

        if (axisX <= -GP_AXIS_DEADZONE) gamepadCurrent[GP_LEFT] = 1;
        else if (axisX >= GP_AXIS_DEADZONE) gamepadCurrent[GP_RIGHT] = 1;

        if (axisY >= GP_AXIS_DEADZONE) gamepadCurrent[GP_SOFT_DROP] = 1;

        if (btns) {
          if (isGamepadButtonDown(btns[14])) gamepadCurrent[GP_LEFT] = 1;
          if (isGamepadButtonDown(btns[15])) gamepadCurrent[GP_RIGHT] = 1;
          if (isGamepadButtonDown(btns[13])) gamepadCurrent[GP_SOFT_DROP] = 1;
          if (isGamepadButtonDown(btns[12])) gamepadCurrent[GP_HARD_DROP] = 1;

          if (isGamepadButtonDown(btns[0]) || isGamepadButtonDown(btns[3])) {
            gamepadCurrent[GP_ROTATE_CW] = 1;
          }
          if (isGamepadButtonDown(btns[1]) || isGamepadButtonDown(btns[2])) {
            gamepadCurrent[GP_ROTATE_CCW] = 1;
          }

          if (
            isGamepadButtonDown(btns[4]) ||
            isGamepadButtonDown(btns[5]) ||
            isGamepadButtonDown(btns[6]) ||
            isGamepadButtonDown(btns[7])
          ) {
            gamepadCurrent[GP_HOLD] = 1;
          }

          if (isGamepadButtonDown(btns[9])) {
            gamepadCurrent[GP_PAUSE] = 1;
          }

          if (isGamepadButtonDown(btns[0]) || isGamepadButtonDown(btns[9])) {
            gamepadCurrent[GP_START] = 1;
          }
        }
      }
    }

    if (anyGamepadButtonDown && !gamepadButtonWasDown) {
      if (typeof onGamepadButton === 'function') {
        onGamepadButton();
      }
      if (typeof onUserGesture === 'function') {
        onUserGesture();
      }
    }
    gamepadButtonWasDown = anyGamepadButtonDown;

    const gpLeftPressed = gamepadCurrent[GP_LEFT] === 1 && gamepadPrevious[GP_LEFT] === 0;
    const gpRightPressed = gamepadCurrent[GP_RIGHT] === 1 && gamepadPrevious[GP_RIGHT] === 0;

    if (gpLeftPressed) lastHorizontal = -1;
    else if (gpRightPressed) lastHorizontal = 1;

    const leftActive = isActive('left') || gamepadCurrent[GP_LEFT] === 1;
    const rightActive = isActive('right') || gamepadCurrent[GP_RIGHT] === 1;
    const dir = resolveHorizontal(leftActive, rightActive);

    const leftFresh = isPressed('left') || gpLeftPressed;
    const rightFresh = isPressed('right') || gpRightPressed;
    const fresh = dir !== 0 && (dir < 0 ? leftFresh : rightFresh);

    const shift = stepDas(das, dir, fresh, dasFrames, arrFrames);

    const gpHardDropPressed = gamepadCurrent[GP_HARD_DROP] === 1 && gamepadPrevious[GP_HARD_DROP] === 0;
    const gpRotateCWPressed = gamepadCurrent[GP_ROTATE_CW] === 1 && gamepadPrevious[GP_ROTATE_CW] === 0;
    const gpRotateCCWPressed = gamepadCurrent[GP_ROTATE_CCW] === 1 && gamepadPrevious[GP_ROTATE_CCW] === 0;
    const gpHoldPressed = gamepadCurrent[GP_HOLD] === 1 && gamepadPrevious[GP_HOLD] === 0;
    const gpStartPressed = gamepadCurrent[GP_START] === 1 && gamepadPrevious[GP_START] === 0;

    // Strict rising-edge pause: single trigger on press, requires full release before firing again
    const gpPauseDown = gamepadCurrent[GP_PAUSE] === 1;
    const pauseInputDown = pausePhysicalKeysDown.size > 0 || touchPausePointers.size > 0 || gpPauseDown;
    let pauseTriggered = false;
    if (pauseInputDown) {
      if (!pauseLocked) {
        pauseTriggered = true;
        pauseLocked = true;
      }
    } else {
      pauseLocked = false;
      if (isPressed('pause')) {
        pauseTriggered = true;
      }
    }

    // One Actions object, overwritten every poll (no per-frame allocation).
    // Callers must read it before the next poll; copy it to keep a snapshot.
    actions.shift = shift;
    actions.shiftToWall = arrFrames === 0 && shift !== 0 && das.frames >= dasFrames;
    actions.softDrop = isActive('softDrop') || gamepadCurrent[GP_SOFT_DROP] === 1;
    actions.hardDrop = isPressed('hardDrop') || gpHardDropPressed;

    const cw = isPressed('rotateCW') || gpRotateCWPressed;
    const ccw = isPressed('rotateCCW') || gpRotateCCWPressed;
    actions.rotate = cw ? 1 : ccw ? -1 : 0;

    actions.hold = isPressed('hold') || gpHoldPressed;
    actions.pause = pauseTriggered;
    actions.start = isPressed('start') || gpStartPressed;
    actions.mute = isPressed('mute');
    actions.music = isPressed('music');
    actions.menuX = resolveHorizontal(isPressed('left') || gpLeftPressed, isPressed('right') || gpRightPressed);

    if (anyPressed) clearPressed();
    gamepadPrevious.set(gamepadCurrent);
    return actions;
  }

  function onBlur() {
    pausePhysicalKeysDown.clear();
    touchPausePointers.clear();
    pauseLocked = false;
    reset();
  }

  target.addEventListener('keydown', onKeyDown, KEY_LISTENER_OPTIONS);
  target.addEventListener('keyup', onKeyUp, KEY_LISTENER_OPTIONS);
  target.addEventListener('blur', onBlur);
  if (pointerStart) target.addEventListener('pointerdown', onPointerDown, POINTER_LISTENER_OPTIONS);

  return {
    poll,
    press,
    reset,
    destroy() {
      target.removeEventListener('keydown', onKeyDown, KEY_LISTENER_OPTIONS);
      target.removeEventListener('keyup', onKeyUp, KEY_LISTENER_OPTIONS);
      target.removeEventListener('blur', onBlur);
      if (pointerStart) target.removeEventListener('pointerdown', onPointerDown, POINTER_LISTENER_OPTIONS);
      pausePhysicalKeysDown.clear();
      touchPausePointers.clear();
      pauseLocked = false;
      unbindTouch();
    },
    bindTouch,
  };
}

export function bindTouchControls(root, input) {
  if (typeof input?.bindTouch === 'function') {
    input.bindTouch(root);
  }
}
