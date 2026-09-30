import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUI, overlayContent, isLevelUpFlashOn } from '../src/ui.js';
import { GAME_OVER_DELAY_FRAMES, LEVEL_UP_FLASH_FRAMES, MAX_START_LEVEL } from '../src/config.js';

/** Minimal stand-in for a DOM element that counts text writes. */
function fakeElement(text = '') {
  let value = text;
  const el = {
    writes: 0,
    hidden: false,
    classes: new Set(),
    classWrites: 0,
    classList: {
      toggle(name, on) { this.owner.classWrites++; if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); },
    },
    get textContent() { return value; },
    set textContent(v) { value = v; this.writes++; },
  };
  el.classList.owner = el;
  return el;
}

function setup() {
  const els = {
    score: fakeElement(), hiScore: fakeElement(), level: fakeElement(), lines: fakeElement(),
    overlay: fakeElement(), overlayTitle: fakeElement(), overlaySub: fakeElement(),
    overlayInfo: fakeElement(), well: fakeElement(),
  };
  return { els, ui: createUI(els) };
}

const baseState = (over = {}) => ({
  phase: 'playing', score: 0, hiScore: 0, level: 0, lines: 0, startLevel: 0,
  gameOverTimer: 0, newHiScore: false, levelUpFlash: 0, ...over,
});

test('HUD: zero-padded score (6), top (6), level (2), lines (3)', () => {
  const { els, ui } = setup();
  ui.update(baseState({ score: 1280, hiScore: 4500, level: 7, lines: 12 }));
  assert.equal(els.score.textContent, '001280');
  assert.equal(els.hiScore.textContent, '004500');
  assert.equal(els.level.textContent, '07');
  assert.equal(els.lines.textContent, '012');
});

test('HUD: values wider than the padding are shown in full', () => {
  const { els, ui } = setup();
  ui.update(baseState({ score: 1_234_567, level: 99, lines: 1500 }));
  assert.equal(els.score.textContent, '1234567');
  assert.equal(els.level.textContent, '99');
  assert.equal(els.lines.textContent, '1500');
});

test('HUD: score updates live and only writes when a value changes', () => {
  const { els, ui } = setup();
  ui.update(baseState({ score: 40 }));
  ui.update(baseState({ score: 40 }));
  ui.update(baseState({ score: 40 }));
  assert.equal(els.score.writes, 1);
  ui.update(baseState({ score: 42 }));
  assert.equal(els.score.textContent, '000042');
  assert.equal(els.score.writes, 2);
  assert.equal(els.lines.writes, 1);
});

test('overlay: title and game over screens shown; play phases hidden', () => {
  const { els, ui } = setup();
  ui.update(baseState({ phase: 'title' }));
  assert.equal(els.overlay.hidden, false);
  assert.equal(els.overlayTitle.textContent, 'TETRIS');
  assert.equal(els.overlaySub.textContent, 'PRESS ENTER');

  for (const phase of ['playing', 'are']) {
    ui.update(baseState({ phase }));
    assert.equal(els.overlay.hidden, true, phase);
  }

  ui.update(baseState({ phase: 'gameOver' }));
  assert.equal(els.overlay.hidden, false);
  assert.equal(els.overlayTitle.textContent, 'GAME OVER');
});

test('overlay: PAUSED screen while paused, hidden again on resume', () => {
  const { els, ui } = setup();
  ui.update(baseState({ phase: 'playing' }));
  ui.update(baseState({ phase: 'paused' }));
  assert.equal(els.overlay.hidden, false);
  assert.equal(els.overlayTitle.textContent, 'PAUSED');
  assert.equal(els.overlaySub.textContent, 'PRESS P TO RESUME');
  ui.update(baseState({ phase: 'playing' }));
  assert.equal(els.overlay.hidden, true);
});

test('overlay: prompt fits the 160px well at 8px per character', () => {
  const { els, ui } = setup();
  for (const phase of ['title', 'paused', 'gameOver']) {
    ui.update(baseState({ phase }));
    assert.ok(els.overlaySub.textContent.length * 8 <= 160 - 2 * 6, `${phase} subtitle`);
    assert.ok(els.overlayTitle.textContent.length * 16 <= 160, `${phase} title`);
  }
});

// ---------- Milestone 4 ----------

test('title: level selector shows arrows only where another level exists', () => {
  assert.equal(overlayContent(baseState({ phase: 'title', startLevel: 0 })).info, 'LEVEL   00 >');
  assert.equal(overlayContent(baseState({ phase: 'title', startLevel: 5 })).info, 'LEVEL < 05 >');
  assert.equal(overlayContent(baseState({ phase: 'title', startLevel: MAX_START_LEVEL })).info, 'LEVEL < 19  ');
});

test('title: overlay shows TETRIS, the selector and PRESS ENTER; selector updates live', () => {
  const { els, ui } = setup();
  ui.update(baseState({ phase: 'title', startLevel: 3 }));
  assert.equal(els.overlayTitle.textContent, 'TETRIS');
  assert.equal(els.overlayInfo.hidden, false);
  assert.equal(els.overlayInfo.textContent, 'LEVEL < 03 >');
  assert.equal(els.overlaySub.textContent, 'PRESS ENTER');
  ui.update(baseState({ phase: 'title', startLevel: 4, level: 4 }));
  assert.equal(els.overlayInfo.textContent, 'LEVEL < 04 >');
  assert.equal(els.level.textContent, '04');
});

test('paused: no info line', () => {
  const { els, ui } = setup();
  ui.update(baseState({ phase: 'title' }));
  ui.update(baseState({ phase: 'paused' }));
  assert.equal(els.overlayInfo.hidden, true);
});

test('game over: final score line; NEW TOP when the record was beaten', () => {
  assert.equal(overlayContent(baseState({ phase: 'gameOver', score: 1234 })).info, 'SCORE 001234');
  assert.equal(overlayContent(baseState({ phase: 'gameOver', score: 1234, newHiScore: true })).info, 'NEW TOP 001234');
});

test('game over: PRESS ENTER appears only once Enter is accepted', () => {
  const { els, ui } = setup();
  ui.update(baseState({ phase: 'gameOver', gameOverTimer: 0 }));
  assert.equal(els.overlayTitle.textContent, 'GAME OVER');
  assert.equal(els.overlaySub.textContent, '');
  ui.update(baseState({ phase: 'gameOver', gameOverTimer: GAME_OVER_DELAY_FRAMES - 1 }));
  assert.equal(els.overlaySub.textContent, '');
  ui.update(baseState({ phase: 'gameOver', gameOverTimer: GAME_OVER_DELAY_FRAMES }));
  assert.equal(els.overlaySub.textContent, 'PRESS ENTER');
});

test('TOP tracks a new record live during play', () => {
  const { els, ui } = setup();
  ui.update(baseState({ score: 300, hiScore: 1000 }));
  assert.equal(els.hiScore.textContent, '001000');
  ui.update(baseState({ score: 1500, hiScore: 1000 }));
  assert.equal(els.hiScore.textContent, '001500');
});

test('level-up: well frame flashes in 4-frame beats, then stops', () => {
  const beats = [];
  for (let f = LEVEL_UP_FLASH_FRAMES; f >= 0; f--) beats.push(isLevelUpFlashOn({ levelUpFlash: f }) ? 1 : 0);
  assert.equal(beats[0], 1, 'on immediately');
  assert.equal(beats.at(-1), 0, 'off when finished');
  assert.ok(beats.includes(0) && beats.slice(0, -1).includes(1));

  const { els, ui } = setup();
  ui.update(baseState({ levelUpFlash: LEVEL_UP_FLASH_FRAMES }));
  assert.ok(els.well.classes.has('well--flash'));
  ui.update(baseState({ levelUpFlash: 0 }));
  assert.ok(!els.well.classes.has('well--flash'));
  const writes = els.well.classWrites;
  ui.update(baseState({ levelUpFlash: 0 }));
  assert.equal(els.well.classWrites, writes, 'class only touched on change');
});

test('overlay info lines fit the well', () => {
  for (const state of [
    baseState({ phase: 'title', startLevel: 19 }),
    baseState({ phase: 'gameOver', score: 9_999_999, newHiScore: true }),
  ]) {
    assert.ok(overlayContent(state).info.length * 8 <= 160, overlayContent(state).info);
  }
});

// ---------- Milestone 5 ----------

test('reduced motion: no level-up well flash', () => {
  const { els } = setup();
  const ui = createUI(els, { reducedMotion: () => true });
  ui.update(baseState({ levelUpFlash: LEVEL_UP_FLASH_FRAMES }));
  assert.ok(!els.well.classes.has('well--flash'));
});

test('sound indicator: SOUND ON / SOUND OFF, written only on change', () => {
  const sound = fakeElement();
  const ui = createUI({ ...setup().els, sound });
  ui.setMuted(true);
  assert.equal(sound.textContent, 'SOUND OFF');
  ui.setMuted(false);
  assert.equal(sound.textContent, 'SOUND ON');
  ui.setMuted(false);
  assert.equal(sound.writes, 2);
});
