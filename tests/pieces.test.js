import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIECE_TYPES, TYPE_INDEX, getCells, getAbsoluteCells, getKicks, spawnPiece, createBag,
} from '../src/pieces.js';

// Deterministic RNG (mulberry32) for bag tests.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sortCells = (cells) => cells.map((c) => [...c]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);

function isConnected(cells) {
  const key = ([x, y]) => `${x},${y}`;
  const all = new Set(cells.map(key));
  const seen = new Set([key(cells[0])]);
  const stack = [cells[0]];
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const n of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (all.has(key(n)) && !seen.has(key(n))) { seen.add(key(n)); stack.push(n); }
    }
  }
  return seen.size === cells.length;
}

test('exports seven types with board indices 1–7', () => {
  assert.deepEqual(PIECE_TYPES, ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  assert.deepEqual(TYPE_INDEX, { I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 });
});

test('every rotation is a connected 4-cell tetromino', () => {
  for (const type of PIECE_TYPES) {
    for (let r = 0; r < 4; r++) {
      const cells = getCells(type, r);
      assert.equal(cells.length, 4, `${type} r${r}`);
      assert.ok(isConnected(cells), `${type} r${r} is disconnected`);
    }
  }
});

// Reference SRS states (y-down, [x, y] in bounding box), from tetris.wiki.
const SRS = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
  O: Array(4).fill([[1, 0], [2, 0], [1, 1], [2, 1]]),
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ],
};

test('rotation states match SRS reference', () => {
  for (const type of PIECE_TYPES) {
    for (let r = 0; r < 4; r++) {
      assert.deepEqual(sortCells(getCells(type, r)), sortCells(SRS[type][r]), `${type} r${r}`);
    }
  }
});

test('spawnPiece: rotation 0 at x=3, y=0 (hidden rows)', () => {
  for (const type of PIECE_TYPES) {
    assert.deepEqual(spawnPiece(type), { type, rotation: 0, x: 3, y: 0 });
  }
  // O occupies columns 4–5, JLSTZ columns 3–5, I columns 3–6
  const cols = (t) => [...new Set(getAbsoluteCells(spawnPiece(t)).map(([x]) => x))].sort();
  assert.deepEqual(cols('O'), [4, 5]);
  assert.deepEqual(cols('T'), [3, 4, 5]);
  assert.deepEqual(cols('I'), [3, 4, 5, 6]);
});

test('getAbsoluteCells offsets by piece position', () => {
  const cells = getAbsoluteCells({ type: 'T', rotation: 0, x: 5, y: 10 });
  assert.deepEqual(sortCells(cells), [[6, 10], [5, 11], [6, 11], [7, 11]]);
});

test('kicks: 5 tests starting with [0,0] for every CW/CCW transition', () => {
  for (const type of ['I', 'J', 'L', 'S', 'T', 'Z']) {
    for (let from = 0; from < 4; from++) {
      for (const to of [(from + 1) % 4, (from + 3) % 4]) {
        const kicks = getKicks(type, from, to);
        assert.equal(kicks.length, 5, `${type} ${from}>${to}`);
        assert.deepEqual([...kicks[0]], [0, 0]);
      }
    }
  }
});

test('kicks are y-down (published y-up values negated)', () => {
  // JLSTZ 0>R published: (0,0) (-1,0) (-1,+1) (0,-2) (-1,-2)
  assert.deepEqual(getKicks('T', 0, 1).map((k) => [...k]), [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]);
  // I 0>R published: (0,0) (-2,0) (+1,0) (-2,-1) (+1,+2)
  assert.deepEqual(getKicks('I', 0, 1).map((k) => [...k]), [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]]);
});

test('kicks are symmetric: from>to is the negation of to>from', () => {
  for (const type of ['I', 'T']) {
    for (let from = 0; from < 4; from++) {
      const to = (from + 1) % 4;
      const fwd = getKicks(type, from, to);
      const back = getKicks(type, to, from);
      fwd.forEach(([dx, dy], i) => assert.deepEqual([...back[i]], [-dx || 0, -dy || 0], `${type} ${from}<>${to} #${i}`));
    }
  }
});

test('O never kicks; 180° only tries [0,0]', () => {
  assert.deepEqual(getKicks('O', 0, 1).map((k) => [...k]), [[0, 0]]);
  assert.deepEqual(getKicks('T', 0, 2).map((k) => [...k]), [[0, 0]]);
});

test('bag: each group of 7 deals contains all 7 types', () => {
  const bag = createBag(seeded(42));
  for (let group = 0; group < 50; group++) {
    const dealt = Array.from({ length: 7 }, () => bag.next());
    assert.deepEqual([...dealt].sort(), [...PIECE_TYPES].sort(), `group ${group}`);
  }
});

test('bag: peek does not consume and spans bag boundaries', () => {
  const bag = createBag(seeded(7));
  const preview = bag.peek(10);
  assert.equal(preview.length, 10);
  assert.deepEqual(bag.peek(10), preview);
  assert.deepEqual(Array.from({ length: 10 }, () => bag.next()), preview);
});

test('bag: same seed gives same sequence', () => {
  const a = createBag(seeded(123));
  const b = createBag(seeded(123));
  assert.deepEqual(a.peek(21), b.peek(21));
});
