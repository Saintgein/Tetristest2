// ==========================================================================
//  src/pieces.js
//  Tetromino shapes (SRS rotation states), SRS wall-kick tables and the
//  7-bag randomizer (SPEC §6.1). Pure data + functions, no DOM.
//  Coordinates are [x, y] with y growing downward (SPEC §4).
// ==========================================================================

/** @typedef {'I'|'J'|'L'|'O'|'S'|'T'|'Z'} PieceType */
/** @typedef {0|1|2|3} Rotation */
/** @typedef {{ type: PieceType, rotation: Rotation, x: number, y: number }} Piece */
/** @typedef {[number, number]} Cell */

export const PIECE_TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

/** Board cell value for each type (SPEC §4). */
export const TYPE_INDEX = { I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 };

// Spawn state (rotation 0) inside each piece's bounding box. SRS rotation is a
// pure rotation of this box, so the other three states are derived below.
// O sits in columns 1–2 of a 4-wide box so every piece spawns at x = 3.
const SPAWN_MATRICES = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
  O: [
    [0, 1, 1, 0],
    [0, 1, 1, 0],
    [0, 0, 0, 0],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
};

function rotateCW(matrix) {
  const n = matrix.length;
  return matrix.map((row, y) => row.map((_, x) => matrix[n - 1 - x][y]));
}

function matrixToCells(matrix) {
  const cells = [];
  matrix.forEach((row, y) => row.forEach((filled, x) => {
    if (filled) cells.push(Object.freeze([x, y]));
  }));
  return Object.freeze(cells);
}

// SHAPES[type][rotation] → frozen Cell[] (precomputed; getCells never allocates).
const SHAPES = {};
for (const type of PIECE_TYPES) {
  const states = [SPAWN_MATRICES[type]];
  // O is not square, and rotation doesn't change it anyway.
  for (let r = 1; r < 4; r++) {
    states.push(type === 'O' ? states[0] : rotateCW(states[r - 1]));
  }
  SHAPES[type] = states.map(matrixToCells);
}

/** @returns {Cell[]} the 4 offsets inside the bounding box. */
export function getCells(type, rotation) {
  return SHAPES[type][rotation];
}

/** @returns {Cell[]} the 4 board coordinates of a placed piece. */
export function getAbsoluteCells(piece) {
  return getCells(piece.type, piece.rotation).map(([x, y]) => [piece.x + x, piece.y + y]);
}

// SRS kick tables exactly as published (y-UP), keyed "from>to".
// Source: https://tetris.wiki/Super_Rotation_System
const KICKS_JLSTZ_YUP = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const KICKS_I_YUP = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// Convert to our y-down system: negate every dy (SPEC §6.1 gotcha).
function toYDown(table) {
  const out = {};
  for (const [key, kicks] of Object.entries(table)) {
    // `0 - dy` rather than `-dy` so a zero stays +0, not -0
    out[key] = Object.freeze(kicks.map(([dx, dy]) => Object.freeze([dx, 0 - dy])));
  }
  return out;
}

const KICKS_JLSTZ = toYDown(KICKS_JLSTZ_YUP);
const KICKS_I = toYDown(KICKS_I_YUP);
const NO_KICKS = Object.freeze([Object.freeze([0, 0])]);

/**
 * Kick offsets [dx, dy] (y-down) to try in order when rotating from → to.
 * The first entry is always [0, 0]. O never kicks; non-adjacent rotations
 * (180°) aren't part of SRS and only try [0, 0].
 * @returns {Cell[]}
 */
export function getKicks(type, from, to) {
  if (type === 'O') return NO_KICKS;
  const table = type === 'I' ? KICKS_I : KICKS_JLSTZ;
  return table[`${from}>${to}`] ?? NO_KICKS;
}

// Spawn position: top-left of the bounding box, in the hidden rows (SPEC §8.4).
const SPAWN_X = 3;
const SPAWN_Y = 0;

/** @returns {Piece} */
export function spawnPiece(type) {
  return { type, rotation: 0, x: SPAWN_X, y: SPAWN_Y };
}

/**
 * 7-bag randomizer: every consecutive group of 7 deals contains each type once.
 * @param {() => number} rng returns [0, 1) — inject a seeded one for tests
 * @returns {{ next(): PieceType, peek(n: number): PieceType[] }}
 */
export function createBag(rng = Math.random) {
  const queue = [];

  function refill() {
    const bag = PIECE_TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {   // Fisher–Yates
      const j = Math.floor(rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    queue.push(...bag);
  }

  function ensure(n) {
    while (queue.length < n) refill();
  }

  return {
    next() {
      ensure(1);
      return queue.shift();
    },
    peek(n) {
      ensure(n);
      return queue.slice(0, n);
    },
  };
}
