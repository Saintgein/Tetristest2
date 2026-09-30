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

/** Keys are handled in the capture phase and never passively, so nothing on the page can swallow them first. */
const KEY_LISTENER_OPTIONS = { capture: true, passive: false };
const POINTER_LISTENER_OPTIONS = { capture: true, passive: true };
const NON_START_TARGETS = 'button, a, input, select, textarea, [data-no-start]';

/**
 * @param {EventTarget} target receives keydown / keyup / blur / pointerdown (window in the browser)
 * @param {Record<string, string[]>} bindings action → KeyboardEvent.code list
 * @param {{ dasFrames?: number, arrFrames?: number }} [timing]
 * @param {{ keyFallbacks?: Record<string, string>, pointerStart?: boolean, touchRoot?: Element|null }} [options]
 *        keyFallbacks: KeyboardEvent.key → action when the code is empty/unbound;
 *        pointerStart: a primary click/tap anywhere (except controls) presses Start;
 *        touchRoot: container element with [data-action] virtual buttons
 * @returns {{ poll(): Actions, press(action: string): void, reset(): void, destroy(): void, bindTouch(element: Element): void }}
 */
export function createInput(
  target = window,
  bindings = KEY_BINDINGS,
  { dasFrames = DAS_FRAMES, arrFrames = ARR_FRAMES } = {},
  { keyFallbacks = KEY_FALLBACKS, pointerStart = true, touchRoot = null } = {},
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
    if (e.isComposing || e.keyCode === 229) return;   // IME composing: the key belongs to the text
    if (!resolve(e)) return;
    const { action, id } = hit;
    e.preventDefault();                     // keep the browser from scrolling / clicking with game keys
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
    for (const code of codeDown.keys()) codeDown.set(code, false);
    for (const action of actionNames) heldCount[action] = 0;
    for (let i = 0; i < MAX_TOUCH_POINTERS; i++) {
      const el = activePointerElements[i];
      const pid = activePointerIds[i];
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
    clearPressed();
    lastHorizontal = 0;
    das.dir = 0;
    das.frames = 0;
  }

  // -------------------------------------------------------------------------
  // Virtual touch controls: Pointer Events with setPointerCapture (zero-alloc)
  // -------------------------------------------------------------------------

  function onTouchButtonPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const btn = e.currentTarget || e.target;
    const action = btn?.getAttribute?.('data-action') ?? btn?.dataset?.action;
    if (!action || !(action in pressed)) return;

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

  target.addEventListener('keydown', onKeyDown, KEY_LISTENER_OPTIONS);
  target.addEventListener('keyup', onKeyUp, KEY_LISTENER_OPTIONS);
  target.addEventListener('blur', reset);
  if (pointerStart) target.addEventListener('pointerdown', onPointerDown, POINTER_LISTENER_OPTIONS);

  return {
    poll,
    press,
    reset,
    destroy() {
      target.removeEventListener('keydown', onKeyDown, KEY_LISTENER_OPTIONS);
      target.removeEventListener('keyup', onKeyUp, KEY_LISTENER_OPTIONS);
      target.removeEventListener('blur', reset);
      if (pointerStart) target.removeEventListener('pointerdown', onPointerDown, POINTER_LISTENER_OPTIONS);
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
