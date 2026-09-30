# Retro Tetris — Technical Specification

A browser-based classic falling-block game rendered on HTML5 Canvas with an
8/16-bit arcade look. Pure HTML + CSS + vanilla ES modules. **No frameworks,
no build step, no image/audio assets** — every pixel and every sound is
generated in code.

> Status: architecture defined, scaffolding in place (Milestone 0).
> Implementation order lives in [TASKS.md](TASKS.md).

---

## 1. Goals & Non-Goals

**Goals**
- Authentic retro presentation: pixel-perfect integer scaling, beveled blocks,
  dark arcade cabinet frame, bitmap-style font, CRT scanlines.
- NES-style progression: gravity table that speeds up through level 99, level
  driven by lines cleared plus score-milestone bonus levels.
- Tight, responsive controls with our own DAS/ARR (browser key-repeat ignored).
- Deterministic, frame-based simulation at a fixed 60 Hz.

**Non-goals (for now)**
- Multiplayer, touch/gamepad controls, online leaderboards, T-spin scoring,
  combo/back-to-back bonuses. The architecture should not preclude them.

---

## 2. Tech Constraints

| Area       | Decision |
|------------|----------|
| Language   | ES2022 modules (`<script type="module">`), no transpiling |
| Rendering  | Canvas 2D, `imageSmoothingEnabled = false`, integer CSS scaling |
| Styling    | Single `style.css`, CSS custom properties, no preprocessors |
| Font       | "Press Start 2P" (Google Fonts) with `monospace` fallback — the only external resource; game must remain fully playable if it fails to load |
| Audio      | Web Audio API oscillators (square/triangle/noise), synthesized at runtime |
| Persistence| `localStorage` for high score and settings |
| Tests      | `node --test` on the pure modules (no DOM): `pieces`, `board`, `progression`, `input` DAS logic |
| Serving    | Any static server (ES modules don't load over `file://`): `npx serve .`, `python -m http.server`, or VS Code Live Server |

---

## 3. File Structure

```
/
├── index.html          # Cabinet markup: board, hold, next, HUD, overlay
├── style.css           # Retro arcade styling, pixel scaling, CRT overlay
├── SPEC.md             # This document
├── TASKS.md            # Milestone plan & checklist
├── package.json        # (M1) { "type": "module", "scripts": { "test": "node --test" } } — no deps
├── src/
│   ├── main.js         # Bootstrap: DOM lookup, scaling, wires modules, starts loop
│   ├── config.js       # All tunable constants (grid, timing, keys, palette)
│   ├── pieces.js       # Tetromino shapes, SRS rotation + kick tables, 7-bag
│   ├── board.js        # Grid data, collision, locking, line detection/clearing
│   ├── progression.js  # Gravity table, level computation, scoring
│   ├── input.js        # Keyboard state, bindings, DAS/ARR → per-frame actions
│   ├── game.js         # State object, state machine, fixed-timestep loop, rules
│   ├── renderer.js     # Canvas drawing: beveled blocks, board, ghost, previews, FX
│   ├── ui.js           # DOM HUD (score/level/lines) + overlay screens
│   └── audio.js        # Synthesized SFX (Web Audio)
└── tests/
    ├── pieces.test.js
    ├── board.test.js
    ├── progression.test.js
    └── input.test.js
```

### Dependency graph (arrows = imports)

```
main ──► game ──► board ──► pieces ──► config
  │        ├────► pieces
  │        ├────► progression ──► config
  │        └────► config
  ├──► input ──► config
  ├──► renderer ──► pieces, config
  ├──► ui ──► config
  └──► audio
```

Rules:
- `pieces`, `board`, `progression` are **pure** (no DOM, no globals, no
  `Math.random` except via injected RNG) → unit-testable in Node.
- `game` owns the state and rules but never touches the DOM; it talks to
  `renderer`, `ui`, `audio`, `input` only through the objects passed into
  `createGame()`.
- Only `main`, `renderer`, `ui`, `input`, `audio` touch browser APIs.

---

## 4. Coordinate System & Grid

- Grid is **10 columns × 22 rows**: rows `0–1` are hidden spawn rows, rows
  `2–21` are the 20 visible rows. `y` grows **downward**, `x` grows right.
- Cell values: `0` = empty, `1–7` = locked block of piece type index
  (`I=1, J=2, L=3, O=4, S=5, T=6, Z=7`).
- Logical pixel size: **`BLOCK = 16`** px. Board canvas = `160 × 320` logical
  px (visible rows only). The whole page is scaled by an integer `--scale`
  factor computed in `main.js`, so each logical pixel is an exact N×N square.

---

## 5. Configuration (`src/config.js`)

All magic numbers live here. Frame counts assume 60 fps.

```js
export const COLS = 10;
export const VISIBLE_ROWS = 20;
export const HIDDEN_ROWS = 2;
export const ROWS = VISIBLE_ROWS + HIDDEN_ROWS;   // 22
export const BLOCK = 16;                          // logical px per cell
export const PREVIEW_BLOCK = 16;

export const FPS = 60;
export const STEP_MS = 1000 / FPS;
export const MAX_FRAME_MS = 250;                  // clamp after tab-switch stalls

export const DAS_FRAMES = 10;                     // ~167 ms before auto-repeat
export const ARR_FRAMES = 2;                      // ~33 ms between repeats (0 = instant to wall)
export const SOFT_DROP_G = 0.5;                   // rows/frame while soft-dropping (min)
export const LOCK_DELAY_FRAMES = 30;              // base lock delay (see progression)
export const MAX_LOCK_RESETS = 15;                // move-reset cap per piece
export const LINE_CLEAR_FRAMES = 20;              // clear animation length
export const ARE_FRAMES = 6;                      // entry delay after lock
export const NEXT_COUNT = 3;                      // previews shown
export const MAX_LEVEL = 99;
export const MAX_START_LEVEL = 19;
export const SCORE_MILESTONE = 10_000;            // see §8.2

export const KEY_BINDINGS = {
  left:      ['ArrowLeft', 'KeyA'],
  right:     ['ArrowRight', 'KeyD'],
  softDrop:  ['ArrowDown', 'KeyS'],
  hardDrop:  ['Space'],
  rotateCW:  ['ArrowUp', 'KeyX', 'KeyW'],
  rotateCCW: ['KeyZ'],                    // no Ctrl: Ctrl+W (rotate CW) would close the tab
  hold:      ['KeyC', 'ShiftLeft', 'ShiftRight'],
  pause:     ['KeyP', 'Escape'],
  start:     ['Enter'],
  mute:      ['KeyM'],
};

// Per piece type index 1–7: face, highlight (top/left bevel), shadow (bottom/right bevel)
export const PALETTE = {
  1: { face: '#3cbcfc', light: '#a4e4fc', dark: '#0078b8' }, // I cyan
  2: { face: '#0058f8', light: '#6888fc', dark: '#0000a8' }, // J blue
  3: { face: '#f87800', light: '#fcb868', dark: '#a84000' }, // L orange
  4: { face: '#f8b800', light: '#fce0a8', dark: '#ac7c00' }, // O yellow
  5: { face: '#00b800', light: '#b8f818', dark: '#006800' }, // S green
  6: { face: '#b800b8', light: '#f878f8', dark: '#680068' }, // T purple
  7: { face: '#e40058', light: '#f87898', dark: '#a80020' }, // Z red
};
export const COLORS = {
  wellBg: '#000000', gridDot: '#1a1a2e', ghost: 'rgba(255,255,255,0.35)', flash: '#fcfcfc',
};
```

Keys use `KeyboardEvent.code` (layout-independent physical keys).

---

## 6. Module APIs

Type shorthand used below:

```js
/** @typedef {'I'|'J'|'L'|'O'|'S'|'T'|'Z'} PieceType */
/** @typedef {0|1|2|3} Rotation   // 0=spawn, 1=R (CW), 2=180, 3=L (CCW) */
/** @typedef {{ type: PieceType, rotation: Rotation, x: number, y: number }} Piece
 *  x,y = top-left of the piece's bounding box (4×4 for I, 3×3 for JLSTZ, O is 4×3 box w/ blocks in cols 1–2) */
/** @typedef {[number, number]} Cell  // [x, y] */
/** @typedef {{ cols: number, rows: number, cells: Uint8Array[] }} Board  // cells[y][x] */
```

### 6.1 `pieces.js`

```js
export const PIECE_TYPES: PieceType[];                 // ['I','J','L','O','S','T','Z']
export const TYPE_INDEX: Record<PieceType, number>;    // I→1 … Z→7
export function getCells(type, rotation): Cell[];      // 4 offsets inside the bounding box (SRS states)
export function getAbsoluteCells(piece): Cell[];       // offsets + piece.x/y
export function getKicks(type, from, to): Cell[];      // SRS kick offsets to try, in order, first is [0,0]
export function spawnPiece(type): Piece;               // rotation 0, x = 3, y = 0 (hidden rows)
export function createBag(rng = Math.random): { next(): PieceType, peek(n): PieceType[] };
```

- Shapes follow **SRS** (Super Rotation System) states.
- Kick tables: standard SRS JLSTZ table and separate I table; O never kicks.
  **Gotcha:** published SRS tables use *y-up*; negate every `dy` when
  building our y-down tables.
- `createBag` is a 7-bag randomizer (shuffle all 7, deal, refill). `peek(n)`
  refills across bag boundaries as needed, so the next-queue is always
  available. RNG is injectable for deterministic tests.

### 6.2 `board.js`

```js
export function createBoard(cols = COLS, rows = ROWS): Board;
export function inBounds(board, x, y): boolean;
export function isValidPosition(board, piece): boolean;   // all cells in bounds & empty
export function lockPiece(board, piece): void;            // write TYPE_INDEX into cells (mutates)
export function findFullRows(board): number[];            // ascending y
export function clearRows(board, rows): number;           // remove rows, shift down, returns count
export function isLockOut(piece): boolean;                // every cell in hidden rows (y < HIDDEN_ROWS)
export function dropDistance(board, piece): number;       // rows until collision (ghost + hard drop)
```

Cells above the top (`y < 0`) are **invalid** (the 2 hidden rows provide
headroom). `clearRows` must handle non-contiguous rows.

### 6.3 `progression.js`

```js
export const GRAVITY_EPSILON = 1e-9;                     // accumulator tolerance, see §8.1
export function getGravity(level): number;               // rows per frame (G)
export function getLockDelay(level): number;             // frames
export function linesToFirstLevelUp(startLevel): number;
export function levelFromLines(startLevel, lines): number;
export function scoreBonusLevels(score): number;
export function computeLevel({ startLevel, lines, score }): number;  // clamped to MAX_LEVEL
export function scoreForClear(lineCount, level): number;
export const SOFT_DROP_POINTS = 1;                       // per row
export const HARD_DROP_POINTS = 2;                       // per row
```

Details in §8.

### 6.4 `input.js`

```js
export function createInput(
  target = window,
  bindings = KEY_BINDINGS,
  { dasFrames = DAS_FRAMES, arrFrames = ARR_FRAMES } = {},   // override for tests / settings
): Input;
// Held state is tracked per KeyboardEvent.code, so aliases (ArrowLeft + KeyA)
// don't release each other; a second alias of a held action is not a new press.

/** @typedef {Object} Input
 * @property {() => Actions} poll      called exactly once per simulation frame
 * @property {() => void}    reset     clear held state (on blur / phase change)
 * @property {() => void}    destroy   remove listeners
 */
/** @typedef {Object} Actions
 * @property {-1|0|1}  shift      horizontal step this frame (after DAS/ARR); with ARR 0 → `shiftToWall`
 * @property {boolean} shiftToWall
 * @property {boolean} softDrop   held
 * @property {boolean} hardDrop   edge (pressed this frame)
 * @property {-1|0|1}  rotate     edge: 1 = CW, -1 = CCW
 * @property {boolean} hold       edge
 * @property {boolean} pause      edge
 * @property {boolean} start      edge
 * @property {boolean} mute       edge
 * @property {-1|0|1}  menuX      edge left/right (title screen level select)
 */
```

Internals — keep the DAS math in a pure helper so it's Node-testable:

```js
export function emptyActions(): Actions;                   // all false / 0 — base for tests
export function createDasState(): { dir: -1|0|1, frames: number };
/** Advances DAS one frame. `dir` = resolved horizontal direction this frame,
 *  `fresh` = that direction's key had a press edge since the last poll. */
export function stepDas(das, dir, fresh, dasFrames, arrFrames): -1|0|1;
```

```js
function stepDas(das, dir, fresh, dasFrames, arrFrames) {
  if (dir === 0) { das.dir = 0; das.frames = 0; return 0; }
  if (dir !== das.dir || fresh) { das.dir = dir; das.frames = 0; return dir; } // initial shift
  das.frames++;
  if (das.frames < dasFrames) return 0;                  // charging
  if (arrFrames === 0) return dir;                       // poll() also sets shiftToWall
  return (das.frames - dasFrames) % arrFrames === 0 ? dir : 0;
}
```

With `DAS_FRAMES = 10, ARR_FRAMES = 2`, holding a direction shifts on poll
indices 0, 10, 12, 14, … (initial shift, ~167 ms charge, then 30 cells/s).
Authentic NES timing is `DAS 16 / ARR 6`; that's a `config.js` change only.

- `keydown`/`keyup` listeners record `held` (Set of action names) and
  `pressed` (edges since last poll). Look up actions by `e.code`.
  `e.repeat` events are **ignored** — we implement repeat ourselves.
- `preventDefault()` on any bound key (stops arrow/space page scroll),
  including repeats.
- Resolving `dir` in `poll()`: a direction counts as active if it is held
  **or** has a press edge this poll (so a tap released before the next frame
  still shifts once). If both are active, **last-pressed wins**.
- A fresh press edge always restarts DAS, even if `das.dir` already matches.
- `softDrop` is active if held or pressed this poll. `rotate`: CW edge → 1,
  else CCW edge → −1. `menuX` mirrors the horizontal press edges.
- `poll()` clears `pressed` and returns a new `Actions` object.
- `target` `blur` → `reset()` so keys don't stick. `reset()` clears `held`,
  `pressed` and the DAS state.

### 6.5 `renderer.js`

```js
export function createRenderer({ boardCanvas, holdCanvas, nextCanvas }): Renderer;

/** @typedef {Object} Renderer
 * @property {(state: GameState) => void} render
 */

// Internal but exported for testing/reuse:
export function drawBlock(ctx, px, py, size, colorIndex, style = 'normal'): void; // 'normal' | 'ghost' | 'flash'
export function buildBlockSprites(size): Map<number, HTMLCanvasElement>;           // pre-rendered per color
```

Block look (16 px cell, 1 logical px = 1 canvas px):

```
row 0      : 1px dark outline (#000 at 50%)            ┐
rows 1-2   : `light` highlight band (top + left edge)  │ bevel width 2px
body       : `face` fill                               │
rows 14-15 : `dark` shadow band (bottom + right edge)  │
spec pixel : 2×2 white-ish at (3,3) for 16-bit sheen   ┘
```

- Blocks are pre-rendered once per color to offscreen canvases
  (`buildBlockSprites`) and blitted with `drawImage` — no per-frame gradients.
- Ghost piece: outline-only (2px `COLORS.ghost` border) — no fill.
- Draw order: well background + grid dots → locked cells → ghost → active
  piece → line-clear FX → (paused: nothing on board; overlay covers it).
- Only rows `HIDDEN_ROWS..ROWS-1` are drawn; draw `y - HIDDEN_ROWS`. The active
  piece's hidden-row cells are clipped.
- Line-clear FX: during `lineClear` phase, cleared rows flash white on even
  4-frame intervals and wipe from the center outward (NES-style), driven by
  `state.clearing.timer / LINE_CLEAR_FRAMES`.
- Hold/Next canvases: pieces centered in their slot; hold is drawn dimmed
  (globalAlpha 0.4) when `hold.used` is true.
- Redraw every rAF frame — the scene is tiny, dirty-tracking isn't worth it
  for the board. (HUD text in `ui.js` *is* dirty-tracked.)

### 6.6 `ui.js`

```js
export function createUI(elements): UI;
/** @typedef {Object} UI
 * @property {(state: GameState) => void} update   // writes HUD only when values change
 */
```

`elements` = `{ score, hiScore, level, lines, overlay, overlayTitle, overlaySub }`.
Overlay content per phase:

| phase      | title                    | sub                   |
|------------|--------------------------|-----------------------|
| `title`    | `TETRIS`                 | `LEVEL < 00 >` / `PRESS ENTER` |
| `paused`   | `PAUSE`                  | `PRESS P`             |
| `gameOver` | `GAME OVER`              | `SCORE 000000` / `PRESS ENTER` |
| otherwise  | *(overlay hidden)*       |                       |

Number formatting: score 6 digits zero-padded (7+ when exceeded), level 2
digits, lines 3 digits.

### 6.7 `audio.js`

```js
export function createAudio(): Audio;
/** @typedef {Object} Audio
 * @property {(name: SfxName) => void} play
 * @property {() => void} unlock        // resume AudioContext on first user gesture
 * @property {(muted: boolean) => void} setMuted
 * @property {boolean} muted
 */
/** @typedef {'move'|'rotate'|'softDrop'|'hardDrop'|'lock'|'hold'|'clear'|'tetris'|'levelUp'|'gameOver'|'pause'} SfxName */
```

Each SFX is a tiny declarative recipe (wave, start/end freq, duration,
volume envelope) played through a shared master `GainNode`. Must be a no-op
(not throw) if Web Audio is unavailable or still locked.

### 6.8 `game.js`

```js
export function createGame({
  input, renderer, ui, audio,
  storage = localStorage,
  initialState = createInitialState(),
  raf = requestAnimationFrame, caf = cancelAnimationFrame,   // injectable for tests
}): Game;
export function createInitialState({ startLevel = 0, hiScore = 0, rng = Math.random } = {}): GameState;
export function update(state, actions, events): void;   // one 60 Hz tick, pure w.r.t. DOM

// Fixed-timestep clock (pure; see §9)
export function createClock(): { last: number | null, acc: number };
export function advanceClock(clock, nowMs, stepMs = STEP_MS, maxFrameMs = MAX_FRAME_MS): number; // steps to run

/** @typedef {Object} Game
 * @property {() => void} start   // begins rAF loop (title screen)
 * @property {() => void} stop
 * @property {() => GameState} getState
 */
```

`update` pushes SFX/notifications into `events: SfxName[]` instead of calling
`audio` directly — this keeps rules testable and decoupled.

---

## 7. Game State

Single mutable object owned by `game.js`. Everything the renderer and UI need
is readable from here; nothing else holds game data.

```js
/** @typedef {'title'|'playing'|'lineClear'|'are'|'paused'|'gameOver'} Phase */

const state = {
  phase: 'title',              // Phase
  pausedFrom: null,            // Phase to resume into after 'paused'
  frame: 0,                    // total simulated frames (drives blink/FX)

  board: createBoard(),        // Board
  active: null,                // Piece | null
  rng,                         // () => number — kept so newGame() can build a fresh bag
  bag,                         // from createBag(rng)
  queue: [],                   // PieceType[NEXT_COUNT] (mirror of bag.peek for renderer)
  hold: { type: null, used: false },

  gravityAcc: 0,               // fractional rows accumulated
  lock: {
    timer: 0,                  // frames spent grounded
    resets: 0,                 // move-resets used this piece
    lowestY: 0,                // deepest y reached (restores resets when exceeded)
  },
  clearing: null,              // { rows: number[], timer: number } during 'lineClear'
  areTimer: 0,                 // frames left in 'are'

  startLevel: 0,
  level: 0,
  lines: 0,
  score: 0,
  hiScore: 0,
  stats: { pieces: 0, singles: 0, doubles: 0, triples: 0, tetrises: 0 },
  levelUpFlash: 0,             // frames remaining for level-up FX
};
```

---

## 8. Game Rules

### 8.1 Gravity & lock

- **Gravity** (`getGravity(level)`, rows/frame):
  - Levels 0–28: NES frames-per-row table, G = `1 / framesPerRow`

    | Level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10–12 | 13–15 | 16–18 | 19–28 |
    |-------|---|---|---|---|---|---|---|---|---|---|-------|-------|-------|-------|
    | Frames/row | 48 | 43 | 38 | 33 | 28 | 23 | 18 | 13 | 8 | 6 | 5 | 4 | 3 | 2 |

  - Level 29: 1 row/frame (NES "kill screen" speed).
  - Levels 30–99: linear ramp `G = 1 + (level − 29) × (19 / 70)` → 20 G at 99
    (piece effectively appears on the stack).
  - **Float gotcha:** summing `1/framesPerRow` drifts below 1.0 at the
    expected frame for levels 2–5, 7 and 9 (e.g. six additions of `1/6` give
    `0.9999…`), costing an extra frame per row. Compare with
    `gravityAcc >= 1 - GRAVITY_EPSILON` (`GRAVITY_EPSILON = 1e-9`, exported
    from `progression.js`) and clamp `gravityAcc` to ≥ 0 after subtracting.
- Soft drop uses `max(G, SOFT_DROP_G)`; each row moved by soft drop scores 1.
- **Lock delay** (`getLockDelay(level)`): `LOCK_DELAY_FRAMES` (30) through
  level 29, then linearly down to 12 frames at level 99.
  - Timer runs while the piece is grounded (`dropDistance === 0`).
  - A successful move/rotate while the timer is running (`lock.timer > 0`)
    resets it to 0, up to `MAX_LOCK_RESETS` per piece; after that the timer
    runs out normally. Moves while airborne don't spend resets. Reaching a new
    `lowestY` (by falling, not by kicking upward) restores the budget.
  - Timing: the frame a piece lands counts as timer 1, so it locks
    `getLockDelay(level) − 1` frames after landing.
  - Hard drop locks immediately.

### 8.2 Levels

Base level from lines (NES rule, supports start levels 0–19):

```
first = min(startLevel * 10 + 10, max(100, startLevel * 10 - 50))
levelFromLines = lines < first ? startLevel
                              : startLevel + 1 + floor((lines - first) / 10)
```

Score milestones grant **bonus levels** on escalating thresholds — the n-th
bonus at `SCORE_MILESTONE × n(n+1)/2` (10k, 30k, 60k, 100k, 150k, …) so the
score→speed feedback loop can't run away:

```
scoreBonusLevels(score) = floor((sqrt(1 + 8 * score / SCORE_MILESTONE) - 1) / 2)
level = min(MAX_LEVEL, levelFromLines + scoreBonusLevels)
```

Level is recomputed after every lock; if it increased, emit `levelUp` and set
`levelUpFlash`.

### 8.3 Scoring (NES)

| Lines | Points            |
|-------|-------------------|
| 1     | 40 × (level + 1)  |
| 2     | 100 × (level + 1) |
| 3     | 300 × (level + 1) |
| 4     | 1200 × (level + 1)|

Uses the level *before* the clear is applied. Soft drop +1/row, hard drop
+2/row.

### 8.4 Spawning, hold, game over

- Spawn: `spawnPiece(bag.next())` at x = 3, y = 0 (hidden rows), rotation 0.
  Immediately apply one row of gravity if the cells below are free so the
  piece becomes visible (guideline behavior).
- **Block out:** if the spawned piece isn't valid → `gameOver`.
- **Lock out:** if a locked piece lies entirely in hidden rows → `gameOver`.
- **Hold:** allowed once per piece (`hold.used`). Swaps active type with held
  type (or pulls from bag if empty), respawns at spawn position/rotation,
  resets gravity and lock state. `hold.used` clears when a piece locks.
- On game over: update `hiScore` + persist to `localStorage['tetris.hiScore']`.

### 8.5 Rotation

`tryRotate(state, dir)`: compute `to = (rotation + dir + 4) % 4`, iterate
`getKicks(type, from, to)`, take the first offset where `isValidPosition`
holds. If none succeed, rotation fails silently (no SFX).

---

## 9. Game Loop

Fixed-timestep simulation, variable-rate rendering:

```js
const CLOCK_SLOP_MS = 0.5;   // absorbs rAF timestamp jitter (16.66 vs 16.67 ms)

function advanceClock(clock, now, stepMs = STEP_MS, maxFrameMs = MAX_FRAME_MS) {
  if (clock.last === null) { clock.last = now; return 0; }   // first frame / after stop()
  const dt = Math.min(Math.max(0, now - clock.last), maxFrameMs);
  clock.last = now;
  clock.acc += dt;
  const steps = Math.floor((clock.acc + CLOCK_SLOP_MS) / stepMs);
  clock.acc -= steps * stepMs;                                // may dip ≤ 0.5 ms below 0
  return steps;
}

function frame(now) {
  const steps = advanceClock(clock, now);
  for (let i = 0; i < steps; i++) {
    const prevPhase = state.phase;
    events.length = 0;                        // one reused array
    update(state, input.poll(), events);
    for (const e of events) audio.play(e);
    if (state.phase !== prevPhase && touchesMenu(prevPhase, state.phase)) input.reset();
  }
  renderer.render(state);
  ui.update(state);
  rafId = raf(frame);
}
// touchesMenu: either phase ∈ {'title', 'paused', 'gameOver'}. Never reset
// between 'playing' / 'are' / 'lineClear', so DAS charge carries across pieces.
```

- Without `CLOCK_SLOP_MS`, a 60 Hz display alternates 0 and 2 steps on some
  frames because rAF deltas straddle `STEP_MS` — visible as stutter.
- Displays that aren't exactly 60 Hz still get a rare single correction to
  stay real-time: 59.94 Hz gets one double step every ~16 s, and 60.006 Hz gets
  one frame with no step. That's intended; don't "fix" it by locking to vsync.
- `MAX_FRAME_MS = 250` caps catch-up at 15 steps after a stall.
- `document.visibilitychange` → hidden: auto-pause if playing; on resume set
  `clock.last = null` to avoid a catch-up burst.
- Input is polled **inside** the fixed step so DAS timing is frame-exact
  regardless of monitor refresh rate (60/120/144 Hz behave identically).
  At 144 Hz most rAF callbacks run 0 steps; edges simply wait in `pressed`.
- `update()` never touches `input`; the loop owns `input.reset()`.

### 9.1 `update()` — per-phase

```
title:     menuX → adjust startLevel (0..MAX_START_LEVEL); start → newGame()
paused:    pause → phase = pausedFrom
gameOver:  start → phase = 'title'
are:       areTimer--; when 0 → spawnNext()  (block-out check)
lineClear: clearing.timer++; when ≥ LINE_CLEAR_FRAMES → clearRows, score,
           recompute level, phase = 'are'
playing:
  1. pause  → pausedFrom = 'playing', phase = 'paused'; return   (loop resets input)
  2. hold   → tryHold()
  3. rotate → tryRotate()                (grounded success → lock reset)
  4. shift  → tryMove(dx, 0)             (grounded success → lock reset)
  5. hardDrop → move dropDistance rows, +2/row, lockAndAdvance(); return
  6. gravity: gravityAcc += softDrop ? max(G, SOFT_DROP_G) : G
              while gravityAcc ≥ 1 − GRAVITY_EPSILON:
                gravityAcc = max(0, gravityAcc − 1)
                if !tryMove(0,1) {gravityAcc = 0; break}
                if softDrop score += 1
  7. grounded? lock.timer++ ; if ≥ getLockDelay(level) → lockAndAdvance()
               else lock.timer = 0

lockAndAdvance():
  lockPiece → lock-out check → hold.used = false → stats.pieces++
  rows = findFullRows; if rows.length → clearing = {rows, timer:0}, phase = 'lineClear'
                       else phase = 'are', areTimer = ARE_FRAMES
```

---

## 10. Visual Design

- **Cabinet:** dark navy/black background, beveled frame panels (light
  top-left, dark bottom-right inset shadows) around the well, hold, next and
  stat boxes. Logo in the marquee with stacked pixel drop-shadows.
- **Pixel scaling:** everything is sized in logical px via
  `calc(N * var(--px))`, where `--px = var(--scale) * 1px` and `--scale` is an
  integer set by `main.js` from the viewport. Canvases use
  `image-rendering: pixelated`.
- **Font:** Press Start 2P at 8 logical px (multiples of 8 only).
- **CRT:** fixed full-screen overlay with 1px scanlines + subtle vignette,
  `pointer-events: none`. Honor `prefers-reduced-motion` (no blinking/flash).
- **Palette:** NES-inspired (see `PALETTE` in §5).

---

## 11. Testing & Acceptance

- `npm test` (→ `node --test`) runs pure-module tests; no dependencies.
- Required unit coverage: SRS shapes/kicks (incl. y-flip), bag fairness (every
  7 deals contain all 7 types), collision edges, multi/non-contiguous line
  clears, gravity table spot checks (L0=1/48, L19=1/2, L29=1, L99=20), level
  formula (start 0/9/18 transitions, score bonus thresholds), DAS stepping.
- Manual QA checklist per milestone lives in TASKS.md.
- Performance target: steady 60 fps, < 1 ms average update+render on a
  mid-range laptop; zero allocations in the hot render path (sprites cached).
