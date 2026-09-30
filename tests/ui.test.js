import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUI } from '../src/ui.js';

/** Minimal stand-in for a DOM element that counts text writes. */
function fakeElement(text = '') {
  let value = text;
  return {
    writes: 0,
    hidden: false,
    get textContent() { return value; },
    set textContent(v) { value = v; this.writes++; },
  };
}

function setup() {
  const els = {
    score: fakeElement(), hiScore: fakeElement(), level: fakeElement(), lines: fakeElement(),
    overlay: fakeElement(), overlayTitle: fakeElement(), overlaySub: fakeElement(),
  };
  return { els, ui: createUI(els) };
}

const baseState = (over = {}) => ({ phase: 'playing', score: 0, hiScore: 0, level: 0, lines: 0, ...over });

test('HUD: zero-padded score (6), top (6), level (2), lines (3)', () => {
  const { els, ui } = setup();
  ui.update(baseState({ score: 1280, hiScore: 45, level: 7, lines: 12 }));
  assert.equal(els.score.textContent, '001280');
  assert.equal(els.hiScore.textContent, '000045');
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
