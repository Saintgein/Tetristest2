# Retro Tetris

A classic falling-block game in the style of the NES, built with plain HTML5
Canvas, vanilla ES modules and CSS. There are no frameworks, no build step and
no asset files: every block is drawn in code and every sound is synthesized
with the Web Audio API.

## Features

- **NES feel:** gravity from the original frame table, speeding up level by
  level to 20 G at level 99. The level rises every 10 lines, plus bonus levels
  at score milestones. Scoring is 40 / 100 / 300 / 1200 × (level + 1).
- **Modern handling:** SRS rotation with wall kicks, 7-bag randomizer, hold,
  ghost piece, hard drop, 3-piece preview, lock delay with a move-reset cap, and
  DAS/ARR key repeat that's identical on 60 Hz and 144 Hz displays.
- **Retro look:** beveled pixel blocks with a highlight pixel, integer pixel
  scaling, CRT scanlines, an NES-style line-clear flash and wipe, and a tetris
  flash.
- **2A03-style sound:** pulse ×2 (four duty cycles), a stepped triangle and LFSR
  noise channels. There are 13 effects, including a tetris fanfare and a
  game-over jingle.
- **Chiptune music:** a looping 3-voice arrangement of *Korobeiniki* (lead,
  harmony and walking bass) at 140 BPM. It's scheduled a measure ahead on the
  audio clock, with no drift and a seamless loop. It pauses and resumes on the
  exact beat and steps aside while a sound effect uses its channel. B toggles
  it; M mutes everything.
- **Accessibility:** honours `prefers-reduced-motion`. No blinking, no flashes,
  and cleared rows are cut instantly, with identical game timing.
- **Persistence:** top score, mute and music settings, and last start level are
  saved in `localStorage`.

## Running it

ES modules don't load from `file://`, so serve the folder with any static server:

```sh
npx serve .                 # or
python -m http.server 8000  # then open http://localhost:8000
```

VS Code's *Live Server* works too. The only external resource is the
"Press Start 2P" font from Google Fonts. If it can't load, the game falls back
to a monospace font.

## Controls

| Action | Keys |
|---|---|
| Move | ← → or A D (hold to auto-repeat) |
| Soft drop | ↓ or S |
| Hard drop | Space |
| Rotate clockwise | ↑, X or W |
| Rotate counter-clockwise | Z |
| Hold | C or Shift |
| Pause / resume | P or Esc (also pauses automatically when the tab loses focus) |
| All sound on / off | M (or click SOUND in the footer) |
| Music on / off | B (or click MUSIC in the footer) |
| Start / continue | Enter |
| Choose start level (title screen) | ← → (0–19) |

Sound starts after your first keypress, because browsers block audio until the
page gets a user gesture.

## Testing

```sh
npm test        # node --test; no dependencies. Node.js 20+ (developed on 22)
```

About 320 tests cover the pure game logic, and the browser-facing modules are
tested against small fakes:

| Suite | What it covers |
|---|---|
| `pieces` / `board` | SRS shapes and kicks, 7-bag, collision, line clears |
| `progression` | gravity table and accumulator timing for every level, lock delay, scoring, levels |
| `input` | DAS/ARR frame schedule, key aliases, taps between frames |
| `game` | every rule frame by frame: gravity, lock delay, hold, ARE, line-clear phase, pause, game over, persistence, the fixed-timestep loop |
| `renderer` | real pixel colours on a fake canvas (`tests/helpers/fake-canvas.js`): bevels, ghost, previews, clear animation |
| `ui` | HUD formatting, overlay screens, level-up flash |
| `audio` | Fourier series of the duty/triangle waves, LFSR periods, effect scheduling, and the music sequencer (timing across loops, pause/resume on the beat, ducking) on a fake `AudioContext` |
| `perf` | no allocations in steady-state frames of the real game loop, music included (see below) |
| `music-perf` | the sequencer allocates nothing per frame or per note, and its heap stays flat over 100 loops |

### QA URL flags

| Flag | Effect |
|---|---|
| `?level=N` | start at level 0–99 (the menu offers 0–19) |
| `?reducedMotion` | force reduced motion |
| `?debug` | expose `window.__game` and `window.__audio` for scripted browser tests |

## Architecture

```
index.html ─ style.css
src/
  main.js         bootstrap: scaling, wiring, focus/visibility auto-pause, audio unlock
  config.js       every tunable constant (grid, timing, keys, palette, storage keys)
  pieces.js       tetromino shapes (SRS), kick tables, 7-bag         ┐
  board.js        grid, collision, locking, line clearing            │ pure, no DOM:
  progression.js  gravity, lock delay, scoring, levels               │ unit-tested in Node
  game.js         state machine, rules, fixed-timestep loop          ┘
  input.js        keyboard → per-frame actions with DAS/ARR
  renderer.js     canvas drawing from cached block sprites
  ui.js           DOM HUD and overlay screens
  audio.js        2A03-style effects + background-music sequencer
```

- **One state object, one `update()`.** `game.js` owns all game data.
  `update(state, actions, events)` advances exactly one 60 Hz frame. It never
  touches the DOM; it pushes sound names into `events` for the loop to play.
- **Fixed timestep.** The loop accumulates `requestAnimationFrame` time and
  runs whole 1/60 s steps. It polls input once per step and allows 0.5 ms of
  slack so ordinary vsync jitter doesn't cause 0/2-step stutter. Speed is the
  same at any refresh rate, and stalls are capped at 15 catch-up steps.
- **Phases:** `title → playing ⇄ paused`, `playing → lineClear → are → playing`,
  `→ gameOver → title`.
- **No per-frame allocations.** The hot path reuses objects, reads cached piece
  shapes and sprites, and only formats a HUD string when its number changes.
  `tests/perf.test.js` drives the real loop 40,000 frames and checks that heap
  growth doesn't scale with frame count. It found and fixed several V8
  surprises, such as `Set#clear()` and `array.length = 0` both allocating.
- **Documentation:** [SPEC.md](SPEC.md) is the source of truth for every API
  and rule. [TASKS.md](TASKS.md) has the milestone history.

## Browser support

Developed and verified in Firefox, including scripted headless playthroughs.
The code uses standard APIs only (Canvas 2D, Web Audio, `OffscreenCanvas` with a
`<canvas>` fallback), so current Chrome, Edge and Safari should work, but they
haven't been tested yet.

## Credits

Tetris® is a trademark of The Tetris Company. This is an unaffiliated fan and
educational project and contains no original game assets. The music is the
Russian folk song *Korobeiniki* (19th century, public domain) in an original
3-voice arrangement. The font is
[Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) by CodeMan38
(SIL Open Font License).
