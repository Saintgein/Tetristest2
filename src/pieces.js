// ==========================================================================
//  src/pieces.js
//  The seven classic tetrominoes as pure data: four rotation states each
//  (standard grid matrices, 1 = filled / 0 = empty), a retro NES hex color,
//  and a spawn position centered at the top of the hidden buffer.
// ==========================================================================

import { BOARD_WIDTH, HIDDEN_BUFFER } from './config.js';

export const PIECES = {
  I: {
    color: '#00f0f0',
    rotations: [
      [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
      [[0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0]],
      [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0]],
      [[0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0]],
    ],
  },
  J: {
    color: '#0000f0',
    rotations: [
      [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
      [[0, 1, 0], [0, 1, 0], [1, 1, 0]],
      [[0, 0, 0], [1, 1, 1], [0, 0, 1]],
      [[0, 1, 1], [0, 1, 0], [0, 1, 0]],
    ],
  },
  L: {
    color: '#f0a000',
    rotations: [
      [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
      [[0, 0, 1], [0, 1, 0], [0, 1, 1]],
      [[0, 0, 0], [1, 1, 1], [1, 0, 0]],
      [[0, 1, 1], [0, 1, 0], [0, 0, 1]],
    ],
  },
  O: {
    color: '#f0f000',
    rotations: [
      [[1, 1], [1, 1]],
      [[1, 1], [1, 1]],
      [[1, 1], [1, 1]],
      [[1, 1], [1, 1]],
    ],
  },
  S: {
    color: '#00f000',
    rotations: [
      [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
      [[0, 1, 0], [0, 1, 1], [0, 0, 1]],
      [[0, 0, 0], [0, 1, 1], [1, 1, 0]],
      [[1, 0, 0], [1, 1, 0], [0, 1, 0]],
    ],
  },
  T: {
    color: '#a000f0',
    rotations: [
      [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
      [[0, 1, 0], [0, 1, 1], [0, 1, 0]],
      [[0, 0, 0], [1, 1, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 1, 0], [0, 1, 0]],
    ],
  },
  Z: {
    color: '#f00000',
    rotations: [
      [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
      [[0, 0, 1], [0, 1, 1], [0, 1, 0]],
      [[0, 0, 0], [1, 1, 0], [0, 1, 1]],
      [[0, 1, 0], [1, 1, 0], [1, 0, 0]],
    ],
  },
};

export const PIECE_TYPES = Object.keys(PIECES);

// Center a piece horizontally and place it at the top of the hidden buffer.
function computeSpawn(matrix) {
  const width = matrix[0].length;
  return {
    x: Math.floor((BOARD_WIDTH - width) / 2),
    y: -HIDDEN_BUFFER,
  };
}

for (const type of PIECE_TYPES) {
  PIECES[type].spawn = computeSpawn(PIECES[type].rotations[0]);
}

// Filled-cell offsets [x, y] (column, row) for a type at a rotation.
export function getCells(type, rotation) {
  const matrix = PIECES[type].rotations[((rotation % 4) + 4) % 4];
  const cells = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x]) cells.push([x, y]);
    }
  }
  return cells;
}

// Absolute board coordinates [x, y] for a placed piece.
export function getAbsoluteCells(piece) {
  return getCells(piece.type, piece.rotation).map(([ox, oy]) => [
    piece.x + ox,
    piece.y + oy,
  ]);
}

// A fresh piece at its spawn position (rotation 0).
export function spawnPiece(type) {
  const { spawn } = PIECES[type];
  return { type, rotation: 0, x: spawn.x, y: spawn.y };
}