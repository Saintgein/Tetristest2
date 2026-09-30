// ==========================================================================
//  src/ui.js
//  DOM HUD (score / top / level / lines) and the overlay screens (SPEC §6.6).
//  Called every rendered frame; only touches the DOM when a value changes.
// ==========================================================================

import { MAX_START_LEVEL, GAME_OVER_DELAY_FRAMES } from './config.js';

const pad = (value, digits) => String(value).padStart(digits, '0');

/**
 * Title prompt. 29 characters don't fit the 160 px well at 8 px each, so it breaks
 * into two lines that do (the overlay uses white-space: pre-line).
 */
export const TITLE_PROMPT = 'PRESS ENTER\nOR CLICK TO START';
export const TITLE_PROMPT_GAMEPAD = 'PRESS ENTER, TAP\nOR PRESS START';

/** Level selector with arrows only where another level is available: "< 05 >". */
function levelSelector(level) {
  const left = level > 0 ? '<' : ' ';
  const right = level < MAX_START_LEVEL ? '>' : ' ';
  return `LEVEL ${left} ${pad(level, 2)} ${right}`;
}

/** @returns {{ title: string, info: string|null, sub: string } | null} overlay content, null = hidden */
export function overlayContent(state, options = false) {
  const hasGamepad = typeof options === 'boolean' ? options : Boolean(options?.hasGamepad);
  switch (state.phase) {
    case 'title':
      return {
        title: 'TETRIS',
        info: levelSelector(state.startLevel),
        sub: hasGamepad ? TITLE_PROMPT_GAMEPAD : TITLE_PROMPT,
      };
    case 'paused':
      return { title: 'PAUSED', info: null, sub: 'PRESS P TO RESUME' };
    case 'gameOver':
      return {
        title: 'GAME OVER',
        info: `${state.newHiScore ? 'NEW TOP' : 'SCORE'} ${pad(state.score, 6)}`,
        // The prompt appears once Enter is accepted (see GAME_OVER_DELAY_FRAMES)
        sub: state.gameOverTimer >= GAME_OVER_DELAY_FRAMES ? 'PRESS ENTER' : '',
      };
    default:
      return null;
  }
}

/** Level-up flash: frame on/off in 4-frame beats while levelUpFlash counts down. */
export const isLevelUpFlashOn = (state) => state.levelUpFlash > 0 && Math.floor(state.levelUpFlash / 4) % 2 === 1;

/**
 * @param {{ score, hiScore, level, lines, overlay, overlayTitle, overlaySub, overlayInfo?, well?, soundHint? }} elements
 * @param {{ reducedMotion?: () => boolean, hasGamepad?: () => boolean, audioNeedsGesture?: () => boolean }} [options]
 *        reducedMotion: disables the level-up flash;
 *        hasGamepad: indicates if a gamepad is currently connected;
 *        audioNeedsGesture: audio is waiting for a click / key press (shows soundHint)
 * @returns {{ update(state: object): void, setMuted(muted: boolean): void, setMusic(on: boolean): void }}
 *
 * update() runs every frame and must not allocate during play, so numbers are
 * compared before they're formatted and overlay content is only built for the
 * menu phases.
 */
export function createUI(
  { score, hiScore, level, lines, overlay, overlayTitle, overlaySub, overlayInfo, well, sound, music, soundHint },
  { reducedMotion = () => false, hasGamepad = () => false, audioNeedsGesture = () => false } = {},
) {
  const shownNumbers = new Map();              // element → last number shown
  const shownText = new Map();                 // element → last text written
  let overlayHidden = null;
  let infoHidden = null;
  let wellFlash = null;
  let hintShown = null;

  function setNumber(el, value, digits) {
    if (!el || shownNumbers.get(el) === value) return;
    el.textContent = pad(value, digits);
    shownNumbers.set(el, value);
  }

  function setText(el, text) {
    if (!el || shownText.get(el) === text) return;
    el.textContent = text;
    shownText.set(el, text);
  }

  /** On/off toggle button: label text plus aria-pressed for assistive tech. */
  function setToggle(el, label, on) {
    const text = on ? `${label}: ON` : `${label}: OFF`;
    if (!el || shownText.get(el) === text) return;
    setText(el, text);
    el.setAttribute?.('aria-pressed', on ? 'true' : 'false');
  }

  return {
    update(state) {
      setNumber(score, state.score, 6);
      setNumber(hiScore, state.hiScore > state.score ? state.hiScore : state.score, 6);   // TOP tracks a record live
      setNumber(level, state.level, 2);
      setNumber(lines, state.lines, 3);

      const screen = overlayContent(state, hasGamepad());
      const hidden = screen === null;
      if (hidden !== overlayHidden) { overlay.hidden = hidden; overlayHidden = hidden; }
      if (screen) {
        setText(overlayTitle, screen.title);
        setText(overlaySub, screen.sub);
        if (overlayInfo) {
          const noInfo = screen.info === null;
          if (noInfo !== infoHidden) { overlayInfo.hidden = noInfo; infoHidden = noInfo; }
          if (!noInfo) setText(overlayInfo, screen.info);
        }
      }

      const flash = !reducedMotion() && isLevelUpFlashOn(state);
      if (well && flash !== wellFlash) { well.classList.toggle('well--flash', flash); wellFlash = flash; }

      const hint = audioNeedsGesture();
      if (soundHint && hint !== hintShown) { soundHint.hidden = !hint; hintShown = hint; }
    },

    /** Footer SOUND toggle button ("SOUND: ON" / "SOUND: OFF"). */
    setMuted(muted) {
      setToggle(sound, 'SOUND', !muted);
    },

    /** Footer MUSIC toggle button ("MUSIC: ON" / "MUSIC: OFF"). */
    setMusic(on) {
      setToggle(music, 'MUSIC', on);
    },
  };
}
