// ==========================================================================
//  src/ui.js
//  DOM HUD (score / top / level / lines) and the overlay screens (SPEC §6.6).
//  Called every rendered frame; only touches the DOM when a value changes.
// ==========================================================================

/** Overlay text per phase; phases not listed hide the overlay. */
const OVERLAY = {
  title:    { title: 'TETRIS',    sub: 'PRESS ENTER' },
  paused:   { title: 'PAUSED',    sub: 'PRESS P TO RESUME' },
  gameOver: { title: 'GAME OVER', sub: 'PRESS ENTER' },
};

const pad = (value, digits) => String(value).padStart(digits, '0');

/**
 * @param {{ score: HTMLElement, hiScore: HTMLElement, level: HTMLElement, lines: HTMLElement,
 *           overlay: HTMLElement, overlayTitle: HTMLElement, overlaySub: HTMLElement }} elements
 * @returns {{ update(state: object): void }}
 */
export function createUI({ score, hiScore, level, lines, overlay, overlayTitle, overlaySub }) {
  const written = new Map();                   // element → last text written

  function setText(el, text) {
    if (written.get(el) === text) return;
    el.textContent = text;
    written.set(el, text);
  }

  let lastPhase = null;

  return {
    update(state) {
      setText(score, pad(state.score, 6));
      setText(hiScore, pad(state.hiScore, 6));
      setText(level, pad(state.level, 2));
      setText(lines, pad(state.lines, 3));

      if (state.phase === lastPhase) return;
      lastPhase = state.phase;
      const screen = OVERLAY[state.phase];
      overlay.hidden = !screen;
      if (screen) {
        setText(overlayTitle, screen.title);
        setText(overlaySub, screen.sub);
      }
    },
  };
}
