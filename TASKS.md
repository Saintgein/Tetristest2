# Retro Tetris — Task Plan

Five sequential milestones after the scaffolding. Each one ends in a
**playable or visibly verifiable state** and is merged before the next starts.
Signatures and rules referenced here are defined in [SPEC.md](SPEC.md) —
SPEC is the source of truth; update it first if a design changes.

Legend: `[ ]` todo · `[x]` done · **AC** = acceptance criteria

---

## Milestone 0 — Scaffolding ✅

- [x] `SPEC.md`, `TASKS.md`
- [x] `index.html` — cabinet markup, board/hold/next canvases, HUD, overlay
- [x] `style.css` — retro palette, beveled panels, pixel scaling, CRT overlay
- [x] `src/main.js` — placeholder bootstrap: integer `--scale` fitting + empty-well draw

**AC:** served via a static server, the page shows the cabinet, an empty
dotted well, HUD zeros and a blinking "PRESS ENTER"; resizing the window
snaps between integer scales with no blurry pixels.

---

## Milestone 1 — Core data model & static rendering ✅

- [x] `config.js`, `pieces.js`, `board.js` per SPEC §5, §6.1, §6.2
- [x] `package.json` + `tests/pieces.test.js`, `tests/board.test.js` (21 tests)
- [x] `renderer.js` — `drawBlock`, `drawGrid`, `drawBoard`, `drawPiece`
- [x] `main.js` debug scene (visually verified)

**Carried over:** `renderer.js` doesn't yet match SPEC §6.5. There's no
`createRenderer` and no sprite cache, and `drawBlock(ctx, x, y, typeId)` has no
`size`/`style` params, outline or sheen pixel. M2 adds only a thin
`createRenderer` wrapper; M3 brings the rest to spec.

---

## Milestone 2 — Game loop, gravity, input & collision ✅ (pending manual QA)

Goal: a complete, minimal game. Pieces fall at NES speed, move with DAS,
rotate with SRS kicks, hard-drop, lock, clear lines, and the game can be lost.

> **Handoff notes for the implementer.** SPEC.md is the source of truth. Every
> signature below is already defined there; section refs are given. Do not
> change `config.js` values or the `pieces.js` / `board.js` APIs. All collision
> goes through `isValidPosition(board, piece)` — never hand-roll bounds checks.

**Files:** new `src/progression.js`, `src/input.js`, `src/game.js`, `src/ui.js`,
`tests/progression.test.js`, `tests/input.test.js`, `tests/game.test.js`;
edit `src/renderer.js` (add one function), `src/main.js` (replace debug scene).

### Out of scope (later milestones — do NOT implement)

Lock delay (M2 locks the moment a gravity step fails, NES-style) · hold ·
ghost · next/hold canvases · ARE · `lineClear` animation · pause ·
visibility auto-pause · scoring · level-ups · start-level menu · high-score
persistence · audio. Keep the `state` fields for these (SPEC §7) at their
initial values.

### 2.1 `src/progression.js` — gravity only (SPEC §6.3, §8.1)

```js
export const GRAVITY_EPSILON = 1e-9;
export function getGravity(level): number;   // rows per frame, full 0–99 range
```

- Private table, levels 0–29 frames/row:
  `[48,43,38,33,28,23,18,13,8,6, 5,5,5,4,4,4,3,3,3,2, 2,2,2,2,2,2,2,2,2,1]`
- `level ≤ 29` → `1 / table[level]`; `30–99` → `1 + (level − 29) * 19 / 70`.
- Clamp input with `Math.floor` into `0..MAX_LEVEL`.
- The other §6.3 functions are M4. Don't stub them.

### 2.2 `src/input.js` (SPEC §6.4 — read it fully, it has the reference `stepDas`)

```js
export function emptyActions(): Actions;
export function createDasState(): { dir: -1|0|1, frames: number };
export function stepDas(das, dir, fresh, dasFrames, arrFrames): -1|0|1;
export function createInput(target = window, bindings = KEY_BINDINGS, { dasFrames, arrFrames } = {}): Input; // { poll, reset, destroy }
```

- Build a `Map<code, action>` from `bindings` once.
- `keydown`: unbound → ignore. Bound → `preventDefault()`; if `e.repeat`, stop.
  Otherwise, if not already held, add to `held` and `pressed`. For left/right,
  record `lastHorizontal = -1 | 1`.
- `keyup`: `preventDefault()`, remove from `held`. `blur` → `reset()`.
  Listen for all three on `target` (tests pass a fake target).
- `poll()`:
  1. `L = held.has('left') || pressed.has('left')`, same for `R`.
  2. `dir = L && R ? lastHorizontal : L ? -1 : R ? 1 : 0`.
  3. `fresh = dir !== 0 && pressed.has(dir < 0 ? 'left' : 'right')`.
  4. `shift = stepDas(das, dir, fresh, DAS_FRAMES, ARR_FRAMES)`.
  5. `shiftToWall = ARR_FRAMES === 0 && shift !== 0 && das.frames >= DAS_FRAMES`.
  6. Fill in the remaining `Actions` fields per SPEC, clear `pressed`, return a new object.
- Timings come from config: `DAS_FRAMES = 10`, `ARR_FRAMES = 2`. That means
  shifts at poll 0, 10, 12, 14, … (~167 ms charge, then 30 cells/s).

### 2.3 `src/game.js` (SPEC §6.8, §7, §8.4, §8.5, §9)

**Exports**

```js
export function createInitialState({ startLevel = 0, hiScore = 0, rng = Math.random } = {}): GameState;
export function update(state, actions, events): void;
export function createClock(): { last: number | null, acc: number };
export function advanceClock(clock, nowMs, stepMs = STEP_MS, maxFrameMs = MAX_FRAME_MS): number;
export function createGame({ input, renderer, ui, audio, initialState, raf, caf }): { start, stop, getState };
```

**State**

- `createInitialState` returns the **full** SPEC §7 shape. That includes
  `rng`, `bag = createBag(rng)` and `queue = bag.peek(NEXT_COUNT)`, with
  `phase: 'title'`, `level = startLevel` and `board = createBoard()`.
- M2 reads/writes: `phase`, `frame`, `board`, `active`, `rng`, `bag`,
  `queue`, `gravityAcc`, `startLevel`, `level`, `lines`, `stats.pieces`, and
  the `stats` line counters (`singles`…`tetrises`).

**Internal helpers** (not exported; mutate `state`, return what's listed)

| Helper | Behavior |
|---|---|
| `newGame(state, events)` | `Object.assign(state, createInitialState({ startLevel, hiScore, rng }))` from current state, `phase = 'playing'`, `spawnNext(state, events)` |
| `spawnNext(state, events)` | `active = spawnPiece(bag.next())`, `queue = bag.peek(NEXT_COUNT)`, `gravityAcc = 0`. If `!isValidPosition` → `gameOver(state, events)` (block out). Else drop one row if `y+1` is valid (SPEC §8.4). |
| `tryMove(state, dx, dy): boolean` | Mutate `active.x/y`, test `isValidPosition`, revert on failure. No allocation. |
| `tryRotate(state, dir): boolean` | `from = active.rotation`, `to = (from + dir + 4) % 4`. For each `[kx, ky]` of `getKicks(type, from, to)`: set rotation/x/y, test, keep the first valid one. Otherwise restore the original and return `false`. |
| `lockAndAdvance(state, events)` | `lockPiece`, push `'lock'`, `stats.pieces++`, `hold.used = false`. If `isLockOut(active)` → `gameOver`, return. Then `rows = findFullRows` → if any: `clearRows`, `lines += n`, bump `stats` counter, push `'tetris'` (n = 4) or `'clear'`. Finally `spawnNext`. |
| `gameOver(state, events)` | `phase = 'gameOver'`, `active = null`, push `'gameOver'`. |

**`update(state, actions, events)`** — always `state.frame++` first, then:

```
title:    actions.start → newGame
gameOver: actions.start → phase = 'title'
playing:
  1. rotate ≠ 0   → tryRotate(state, rotate)             → push 'rotate' on success
  2. shiftToWall  → while (tryMove(shift, 0)) {}         → push 'move' if it moved
     else shift ≠ 0 → tryMove(shift, 0)                  → push 'move' on success
  3. hardDrop     → active.y += dropDistance(board, active); push 'hardDrop';
                    lockAndAdvance; return
  4. gravity: g = getGravity(level); if softDrop g = max(g, SOFT_DROP_G)
     gravityAcc += g
     while (gravityAcc >= 1 - GRAVITY_EPSILON):
       gravityAcc = max(0, gravityAcc - 1)
       if !tryMove(0, 1): gravityAcc = 0; lockAndAdvance; return
```

Levels 0–28 **must** use the epsilon (see the SPEC §8.1 float gotcha). Six
NES levels are a frame slow per row without it.

**Loop**: implement `advanceClock` and `frame()` exactly as in SPEC §9,
including `CLOCK_SLOP_MS = 0.5`, the single reused `events` array and the
`touchesMenu` → `input.reset()` rule. `start()` is idempotent. `stop()` cancels
the rAF and sets `clock.last = null`. Never use `setInterval`, `Date.now()` or
`performance.now()` — time only comes from the rAF timestamp.

### 2.4 `src/renderer.js` — add, don't refactor

```js
export function createRenderer({ boardCanvas, holdCanvas, nextCanvas }): { render(state): void };
```

Get the board context once (`imageSmoothingEnabled = false`). `render` calls
`drawBoard(ctx, state.board)` and then, if `state.active`, calls
`drawPiece(ctx, state.active)`. Hold/next canvases stay unused until M3.

### 2.5 `src/ui.js` — v1 (SPEC §6.6)

```js
export function createUI({ score, hiScore, level, lines, overlay, overlayTitle, overlaySub }): { update(state): void };
```

- Overlay: `title` → `TETRIS` / `PRESS ENTER`, `gameOver` → `GAME OVER` /
  `PRESS ENTER`, any other phase → `overlay.hidden = true`.
- HUD: score/hiScore `padStart(6, '0')`, level 2, lines 3.
- Write to the DOM only when a value changed (cache the last-written strings).

### 2.6 `src/main.js` — replace the debug scene

Keep `fitScale` and its listeners. Wire the game:

```js
const startLevel = clamp(parseInt(new URLSearchParams(location.search).get('level'), 10) || 0, 0, MAX_LEVEL);
const game = createGame({
  input: createInput(window),
  renderer: createRenderer({ boardCanvas, holdCanvas, nextCanvas }),
  ui: createUI({ /* #hud-score, #hud-hiscore, #hud-level, #hud-lines, #overlay, #overlay-title, #overlay-sub */ }),
  audio: { play() {} },                          // M5
  initialState: createInitialState({ startLevel }),
});
game.start();
```

`?level=N` is a QA aid for checking gravity (the real menu is M4).

### 2.7 Tests (`npm test` must stay green — 21 existing + new)

Use a seeded RNG (copy `seeded()` from `tests/pieces.test.js`) and
`A = (o) => ({ ...emptyActions(), ...o })`. For board setups, assign
`state.active` / `state.board.cells` directly.

**`progression.test.js`**
- `getGravity`: L0 = 1/48, L9 = 1/6, L18 = 1/3, L19 = 1/2, L28 = 1/2, L29 = 1,
  L64 = 10.5, L99 = 20. Out-of-range values clamp.

**`input.test.js`**

`stepDas`:
- Held for 20 polls → shifts at indices `[0, 10, 12, 14, 16, 18]`.
- `dir` 0 resets; switching direction shifts immediately.
- `fresh` restarts the charge.
- `arrFrames = 0` → shifts every poll after the charge.

`createInput` with a fake target `{ addEventListener, removeEventListener }`
and event objects `{ code, repeat: false, preventDefault() {} }`:
- A tap between two polls → exactly one `shift: -1`.
- `e.repeat` is ignored.
- Left held + Right pressed → `+1`; release Right → `-1` immediately.
- `blur` clears held keys.
- `rotate`: CW = 1, CCW = −1.
- Unbound keys aren't `preventDefault`ed.

**`game.test.js`**

Start and spawn:
- title + `start` → `playing`, `active.y === 1`, `queue.length === 3`.
- `gameOver` + `start` → `title`.

Gravity:
- For **every level 0–28**, after `5 × framesPerRow − 1` frames the piece
  moved 4 rows, and after `5 × framesPerRow` frames it moved 5. This is the
  epsilon test.
- Level 29 moves 1 row per frame.
- Level 99 locks on the first frame.
- Soft drop at L0 = 1 row per 2 frames.

Movement and rotation:
- Shift into a wall → `x` unchanged and no `'move'` event.
- `shiftToWall` → leftmost cell at x = 0.
- Wall kick: T at rotation 1, `x = -1`, `y = 10`; rotate CW → rotation 2, `x = 0`.
- A rotation that's blocked on all 5 kicks leaves the piece untouched and
  pushes no event.

Locking and clears:
- Hard drop from spawn → T cells at row 21 cols 3–5 and row 20 col 4, a
  `'hardDrop'` event, and a new piece spawned.
- Row 21 filled except cols 3–6, then I hard drop → `lines === 1`, row 21
  empty, `'clear'` event.
- Rows 18–21 filled except col 0, then I at rotation 3, `x = -1` hard drop →
  `lines === 4`, `'tetris'` event.

Game over:
- Block out: after a hard drop, the next spawn overlaps the stack → `gameOver`.
- Lock out: row 2 cols 3–5 filled, T at spawn hard-drops in place → `gameOver`.

Clock:
- The first call returns 0. The counts below are for the calls after it.
- Steady 16.667 ms deltas → exactly 1 step per call, 60 steps over 60 calls.
- Jittered 16.66 / 16.67 deltas (alternating) → 60 steps over 60 calls, never 0 or 2.
- 144 Hz deltas (6.944 ms) for 1 s → 60 ± 1 steps.
- A 1000 ms gap → 15 steps (clamp).

### Acceptance criteria

Verified with `npm test` (111 tests) and a scripted headless-Firefox playthrough
(real key events, board read back from the canvas). Unchecked items still need a
manual check.

- [x] `npm test` green; no console errors in Firefox. *(Chrome not yet checked.)*
- [x] Enter starts the game and the overlay hides. Level 0 falls one row per
      0.8 s; `?level=19` drops a row every 2 frames; `?level=29` and above
      look near-instant.
- [x] Holding Left: one shift, ~167 ms pause, then a smooth glide to the wall.
      Browser key-repeat has no effect and the page never scrolls.
- [ ] Up/X/W rotate CW, Z rotates CCW. A T against the wall kicks off it.
      *(Up verified in browser; X/W/Z and kicks covered by unit tests only.)*
- [ ] Space hard-drops. Full rows vanish and the LINES counter updates.
      *(Hard drop verified in browser; line clears unit-tested, not played.)*
- [x] Stacking out shows GAME OVER; Enter → title → Enter starts a fresh board.
- [ ] Identical speed on 60 Hz and 144 Hz displays (or DevTools CPU throttle 4×).
      *(Covered by loop tests; not checked on real hardware.)*

---

## Milestone 3 — Controls feel: lock delay, hold, ghost, ARE, pause ✅

Goal: modern handling on top of M2's movement core (DAS, SRS kicks and hard
drop already landed in M2).

**Files:** `src/game.js`, `src/renderer.js`, `src/progression.js`, `src/ui.js`

Core logic (done — 155 tests; NES scoring pulled forward from M4):

- [x] `progression.js`: `getLockDelay(level)`, `scoreForClear`, `SOFT_DROP_POINTS`,
      `HARD_DROP_POINTS` (SPEC §8.1, §8.3)
- [x] `game.js`
  - [x] Lock delay with move-reset cap + `lowestY` refresh (SPEC §8.1); replaces
        M2's lock-on-failed-gravity
  - [x] `tryHold` — once per piece, swapped-in piece gets the rest of the frame's input (SPEC §8.4)
  - [x] `are` phase (`ARE_FRAMES`) between lock and spawn, after clears too
  - [x] Scoring: clears × (level + 1), soft drop 1/row, hard drop 2/row; `hiScore`
        raised at game over (persistence stays in M4)
  - [x] Next queue mirrors `bag.peek(NEXT_COUNT)`; ghost = `y + dropDistance()`
- [x] Tests: lock delay expiry, reset cap, airborne timer, `lowestY` refresh, hold,
      ARE, scoring, next queue / 7-bag, ghost == hard-drop landing (fuzzed), HUD

Rendering (done — pixel tests on a fake canvas + 13/13 headless-Firefox checks):

- [x] `renderer.js` → SPEC §6.5: `buildBlockSprites` cache, `drawBlock(ctx, px, py,
      size, colorIndex, style)` with outline + mitered bevel + sheen pixel, ghost
      (outline), hold canvas (dimmed when used), next canvas (3 slots)

Pause (done — 17 unit tests + 13/13 headless-Firefox checks):

- [x] `paused` phase (P / Esc) from `playing` or `are`; timers frozen, resumes exactly
- [x] Auto-pause on `visibilitychange` (hidden) and window `blur` via `game.pause()`,
      which re-anchors the clock (`clock.last = null`) so there's no catch-up burst
- [x] `ui.js`: `PAUSED` / `PRESS P TO RESUME` overlay; renderer hides stack + previews

**AC:** Piece can slide on the floor ~0.5 s before locking and can't stall
forever (15 resets); hold swaps once per piece; ghost always matches hard-drop
landing spot; P pauses and resumes without a speed burst; switching tabs pauses.

---

## Milestone 4 — Progression, line clears, high score & game-over polish ✅

Goal: the full NES-style difficulty curve and all on-screen information.

**Files:** `src/progression.js`, `src/ui.js`, `src/game.js`, `src/renderer.js`,
`src/main.js`, `index.html`, `style.css`, tests

Verified with `npm test` (241 tests; 19/21 deliberate bugs caught, and the
other 2 have no observable effect) and a headless-Firefox playthrough (21/21
checks, M3 and pause checks still 13/13).

- [x] `progression.js` (SPEC §6.3, §8)
  - [x] `linesToFirstLevelUp(startLevel)`, `levelFromLines(startLevel, lines)`
  - [x] `scoreBonusLevels(score)` (exact at every threshold), `computeLevel({ startLevel, lines, score })`
- [x] `game.js`
  - [x] `lineClear` phase with `clearing = { rows, timer }` for `LINE_CLEAR_FRAMES`,
        then ARE (26 frames to the next piece vs 6 without a clear); pausable
  - [x] Recompute level after every lock and clear; emit `levelUp`, start `levelUpFlash`
  - [x] Title screen: `menuX` adjusts `startLevel` 0–19 (clamped); HUD level follows
  - [x] High score load/save via injectable `storage` (`localStorage['tetris.hiScore']`),
        strict parsing, storage errors swallowed
  - [x] Game over: Enter ignored for `GAME_OVER_DELAY_FRAMES` (1 s); `newHiScore`;
        → title resets to a clean board/HUD, keeping start level and top score
- [x] `ui.js`: title level selector (`LEVEL < 05 >`, arrows hidden at the ends),
      game-over `SCORE` / `NEW TOP` line, delayed `PRESS ENTER`, live TOP,
      level-up well-frame flash (`.well--flash`)
- [x] `renderer.js`: line-clear flash + center-out wipe (`lineClearFrame`), tetris
      full-well flash
- [x] `main.js`: `?debug` exposes `window.__game` for scripted browser tests
- [x] Tests: first level-up at start 0 → 10 lines, start 9 → 100, start 18 → 130;
      bonus levels at 9 999 / 10 000 / 30 000 / 60 000; score table × (level+1);
      level caps at 99; animation beat table; storage edge cases; reload persistence

**AC:** Starting at level 0, 10 lines → level 1 and pieces visibly speed up ✅
(43 frames/row, unit-tested); HUD updates live ✅; clearing 4 lines at level 0
awards 1200 ✅; high score survives a page reload ✅ (browser-verified).
*Starting at 19 "feels NES-fast" still needs a human to play it.*

---

## Milestone 5 — Audio, polish & release

Goal: ship-quality feel and robustness.

**Files:** `src/audio.js`, `src/main.js`, `src/renderer.js`, `style.css`, `index.html`

- [ ] `audio.js` (SPEC §6.7): `createAudio()` with `play`, `unlock`, `setMuted`
  - [ ] Recipes: move, rotate, softDrop, hardDrop, lock, hold, clear, tetris,
        levelUp, gameOver, pause (square/triangle + noise burst for hard drop)
  - [ ] Unlock on first keydown; M toggles mute (persisted)
  - [ ] Safe no-op when Web Audio is unavailable
- [ ] Game-over animation: stack fills top-down with gray blocks (row per 4 frames)
- [ ] Title screen attract details: blinking prompt, level selector arrows
- [ ] Settings persisted: mute, last start level
- [ ] `prefers-reduced-motion`: disable blink, flashes, and CRT flicker
- [ ] Graceful font fallback check (block Google Fonts in DevTools)
- [ ] Performance pass: no allocations in `render()` (Performance panel → no GC saw-tooth)
- [ ] `README.md`: how to run, controls, credits
- [ ] Final QA across Chrome, Firefox, Edge; 60 Hz and high-refresh

**AC:** Every action has a distinct retro sound; muting persists; no console
errors; 60 fps sustained through level 99 at 20 G; game fully playable offline
(with fallback font).

---

## Backlog (post-1.0, not scheduled)

- Gamepad API support · touch controls · T-spin & back-to-back scoring ·
  configurable DAS/ARR in a settings menu · statistics screen (piece counts,
  NES-style) · chiptune background music (Korobeiniki-style loop, synthesized)
