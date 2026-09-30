// ==========================================================================
//  src/ui.js
//  DOM HUD (score / top / level / lines) and the overlay screens (SPEC §6.6).
//  Called every rendered frame; only touches the DOM when a value changes.
// ==========================================================================

import { MAX_START_LEVEL, GAME_OVER_DELAY_FRAMES } from './config.js';

const pad = (value, digits) => String(value).padStart(digits, '0');

/** Level selector with arrows only where another level is available: "< 05 >". */
function levelSelector(level) {
  const left = level > 0 ? '<' : ' ';
  const right = level < MAX_START_LEVEL ? '>' : ' ';
  return `LEVEL ${left} ${pad(level, 2)} ${right}`;
}

/** @returns {{ title: string, info: string|null, sub: string } | null} overlay content, null = hidden */
export function overlayContent(state) {
  switch (state.phase) {
    case 'title':
      return { title: 'TETRIS', info: levelSelector(state.startLevel), sub: 'PRESS ENTER' };
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
 * @param {{ score, hiScore, level, lines, overlay, overlayTitle, overlaySub, overlayInfo?, well? }} elements
 * @returns {{ update(state: object): void }}
 */
export function createUI({ score, hiScore, level, lines, overlay, overlayTitle, overlaySub, overlayInfo, well }) {
  const written = new Map();                   // element → last value written

  function setText(el, text) {
    if (!el || written.get(el) === text) return;
    el.textContent = text;
    written.set(el, text);
  }

  function setFlag(el, key, value, apply) {
    if (!el || written.get(key) === value) return;
    apply(value);
    written.set(key, value);
  }

  return {
    update(state) {
      setText(score, pad(state.score, 6));
      setText(hiScore, pad(Math.max(state.hiScore, state.score), 6));   // TOP tracks a record live
      setText(level, pad(state.level, 2));
      setText(lines, pad(state.lines, 3));

      const screen = overlayContent(state);
      setFlag(overlay, 'overlay.hidden', !screen, (v) => { overlay.hidden = v; });
      if (screen) {
        setText(overlayTitle, screen.title);
        setText(overlaySub, screen.sub);
        setFlag(overlayInfo, 'info.hidden', screen.info === null, (v) => { overlayInfo.hidden = v; });
        if (screen.info !== null) setText(overlayInfo, screen.info);
      }

      setFlag(well, 'well.flash', isLevelUpFlashOn(state), (v) => well.classList.toggle('well--flash', v));
    },
  };
}
