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

## Milestone 1 — Core data model & static rendering

Goal: pieces and board exist as pure data, and can be drawn.

**Files:** `src/config.js`, `src/pieces.js`, `src/board.js`, `src/renderer.js`,
`package.json`, `tests/pieces.test.js`, `tests/board.test.js`

- [ ] `config.js` — all constants from SPEC §5
- [ ] `pieces.js` (SPEC §6.1)
  - [ ] `PIECE_TYPES`, `TYPE_INDEX`
  - [ ] SRS shape table → `getCells(type, rotation): Cell[]`
  - [ ] `getAbsoluteCells(piece): Cell[]`
  - [ ] SRS kick tables (JLSTZ, I; O = `[[0,0]]`), **y-negated** → `getKicks(type, from, to): Cell[]`
  - [ ] `spawnPiece(type): Piece`
  - [ ] `createBag(rng): { next(), peek(n) }`
- [ ] `board.js` (SPEC §6.2)
  - [ ] `createBoard`, `inBounds`, `isValidPosition`, `lockPiece`
  - [ ] `findFullRows`, `clearRows` (non-contiguous safe)
  - [ ] `isLockOut`, `dropDistance`
- [ ] `renderer.js` (SPEC §6.5)
  - [ ] `drawBlock(ctx, px, py, size, colorIndex, style)` — beveled pixel block
  - [ ] `buildBlockSprites(size)` — offscreen cache per color + ghost + flash
  - [ ] `createRenderer({...}).render(state)` — well bg, grid dots, locked cells, active piece
- [ ] `package.json` `{ "type": "module", "scripts": { "test": "node --test" } }`
- [ ] Tests: shapes have 4 cells in every rotation; I/O/T kick spot checks; bag
      deals all 7 in every group of 7 (seeded RNG); collision at walls/floor/stack;
      clearing rows `[5, 7]` shifts correctly.
- [ ] `main.js`: replace placeholder with a debug scene (hand-built board + one of each piece)

**AC:** `npm test` green. Debug scene shows all 7 colors with crisp bevels at
scale 1–4; no anti-aliasing seams between blocks.

---

## Milestone 2 — Game loop, gravity & basic play

Goal: a minimal but complete game — pieces fall, lock, lines clear, you can lose.

**Files:** `src/game.js`, `src/input.js` (basic), `src/progression.js` (gravity only), `src/main.js`

- [ ] `game.js` (SPEC §6.8, §7, §9)
  - [ ] `createInitialState({ startLevel, hiScore, rng }): GameState`
  - [ ] `createGame({ input, renderer, ui, audio }): { start, stop, getState }`
  - [ ] Fixed-timestep loop with accumulator + `MAX_FRAME_MS` clamp (SPEC §9)
  - [ ] `update(state, actions, events)` phase switch: `title`, `playing`, `are`, `gameOver`
  - [ ] Internal helpers: `newGame(state)`, `spawnNext(state)`, `tryMove(state, dx, dy): boolean`,
        `lockAndAdvance(state)`
  - [ ] Block-out and lock-out → `gameOver`
  - [ ] Immediate line clear (animation comes in M4)
- [ ] `progression.js`: `getGravity(level)` for levels 0–29 (NES table)
- [ ] `input.js` v1: `createInput()` with `held`/`pressed` sets, `poll()` returning
      `Actions` with **edge-only** shift (no DAS yet), `preventDefault` on bound keys,
      ignore `e.repeat`, `reset()` on blur
- [ ] Rotation without kicks (plain `isValidPosition` check) — kicks land in M3
- [ ] `main.js`: wire `createInput`, `createRenderer`, stub `ui`/`audio` (`{ update(){} }`, `{ play(){} }`)

**AC:** Enter starts a game at level 0; pieces fall at 48 frames/row; left/right/
rotate/soft drop work one press at a time; full rows disappear; stacking to the
top ends the game and Enter returns to title. Behavior identical on 60 Hz and
144 Hz monitors (verify with DevTools rendering throttling or a high-refresh display).

---

## Milestone 3 — Controls feel: DAS, SRS, hold, ghost, lock delay

Goal: modern, responsive handling.

**Files:** `src/input.js`, `src/game.js`, `src/renderer.js`, `tests/input.test.js`

- [ ] `input.js`
  - [ ] Pure `createDasState()` + `stepDas(das, leftHeld, rightHeld, lastPressed, dasFrames, arrFrames): -1|0|1`
  - [ ] Last-pressed-wins for opposing directions
  - [ ] `ARR_FRAMES = 0` → `shiftToWall`
  - [ ] Soft drop as held action; rotate CW/CCW, hold, hard drop, pause as edges
- [ ] `game.js`
  - [ ] `tryRotate(state, dir): boolean` using SRS kicks (SPEC §8.5)
  - [ ] Hard drop via `dropDistance` (+2/row), immediate lock
  - [ ] Soft drop gravity `max(G, SOFT_DROP_G)` (+1/row)
  - [ ] Lock delay with move-reset cap + `lowestY` refresh (SPEC §8.1)
  - [ ] `tryHold(state): boolean` — once per piece (SPEC §8.4)
  - [ ] Next queue from `bag.peek(NEXT_COUNT)` mirrored into `state.queue`
  - [ ] ARE phase (`ARE_FRAMES`) between lock and spawn
  - [ ] `paused` phase (P / Esc), auto-pause on `visibilitychange`
- [ ] `renderer.js`: ghost piece (outline), hold canvas (dimmed when used), next canvas (3 slots)
- [ ] Tests: `stepDas` — tap = 1 shift; hold 10 frames → repeat every 2; direction
      switch resets; both held → last pressed wins

**AC:** Holding left moves 1 cell, pauses ~167 ms, then glides; T-spin-style
kicks work (T into a notch); I-piece wall kicks match SRS; piece can slide on
the floor ~0.5 s before locking and can't stall forever (15 resets); hold swaps
once per piece; ghost always matches hard-drop landing spot.

---

## Milestone 4 — Progression, scoring & HUD

Goal: the full NES-style difficulty curve and all on-screen information.

**Files:** `src/progression.js`, `src/ui.js`, `src/game.js`, `src/renderer.js`,
`tests/progression.test.js`

- [ ] `progression.js` (SPEC §6.3, §8)
  - [ ] `getGravity(level)` extended to 30–99 (ramp to 20 G)
  - [ ] `getLockDelay(level)` (30 → 12 frames over 30–99)
  - [ ] `linesToFirstLevelUp(startLevel)`, `levelFromLines(startLevel, lines)`
  - [ ] `scoreBonusLevels(score)`, `computeLevel({ startLevel, lines, score })`
  - [ ] `scoreForClear(lineCount, level)`, `SOFT_DROP_POINTS`, `HARD_DROP_POINTS`
- [ ] `game.js`
  - [ ] `lineClear` phase with `clearing = { rows, timer }` for `LINE_CLEAR_FRAMES`
  - [ ] Apply score (pre-clear level), lines, stats; recompute level; emit `levelUp`
  - [ ] Title screen: `menuX` adjusts `startLevel` 0–19
  - [ ] High score load/save (`localStorage['tetris.hiScore']`)
- [ ] `ui.js` (SPEC §6.6): `createUI(elements).update(state)` with dirty-checking;
      overlay text per phase; zero-padded formatting
- [ ] `renderer.js`: line-clear flash + center-out wipe; level-up well-border flash;
      tetris (4 lines) full-well flash
- [ ] Tests: gravity spot checks (L0, L9, L19, L29, L64, L99); first level-up
      at start 0 → 10 lines, start 9 → 100, start 18 → 130; bonus levels at
      9 999 / 10 000 / 30 000 / 60 000; score table × (level+1); level caps at 99.

**AC:** Starting at level 0, 10 lines → level 1 and pieces visibly speed up;
HUD updates live; clearing 4 lines at level 0 awards 1200; starting at 19
feels NES-fast; high score survives a page reload.

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
