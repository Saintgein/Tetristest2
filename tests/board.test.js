import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLS, ROWS, HIDDEN_ROWS } from '../src/config.js';
import {
  createBoard, inBounds, isValidPosition, lockPiece, findFullRows, clearRows, isLockOut, dropDistance,
} from '../src/board.js';
import { spawnPiece } from '../src/pieces.js';

function fillRow(board, y, value = 1) {
  board.cells[y].fill(value);
}

test('createBoard: 10 × 22 grid of empty Uint8Array rows', () => {
  const board = createBoard();
  assert.equal(board.cols, COLS);
  assert.equal(board.rows, ROWS);
  assert.equal(ROWS, 22);
  assert.equal(board.cells.length, 22);
  for (const row of board.cells) {
    assert.ok(row instanceof Uint8Array);
    assert.equal(row.length, 10);
    assert.ok(row.every((v) => v === 0));
  }
});

test('inBounds includes hidden rows, excludes y < 0 and edges', () => {
  const board = createBoard();
  assert.ok(inBounds(board, 0, 0));
  assert.ok(inBounds(board, 9, 21));
  assert.ok(!inBounds(board, -1, 5));
  assert.ok(!inBounds(board, 10, 5));
  assert.ok(!inBounds(board, 5, -1));
  assert.ok(!inBounds(board, 5, 22));
});

test('isValidPosition: walls, floor, ceiling and stack', () => {
  const board = createBoard();
  const t = (x, y, rotation = 0) => ({ type: 'T', rotation, x, y });
  assert.ok(isValidPosition(board, t(3, 0)));
  assert.ok(isValidPosition(board, t(0, 5)));
  assert.ok(!isValidPosition(board, t(-1, 5)), 'left wall');
  assert.ok(isValidPosition(board, t(7, 5)));
  assert.ok(!isValidPosition(board, t(8, 5)), 'right wall');
  assert.ok(isValidPosition(board, t(3, 20)));
  assert.ok(!isValidPosition(board, t(3, 21)), 'floor');
  assert.ok(!isValidPosition(board, t(3, -1)), 'above hidden rows');
  board.cells[11][4] = 7;
  assert.ok(!isValidPosition(board, t(3, 10)), 'overlap with stack');
});

test('lockPiece writes TYPE_INDEX into the piece cells', () => {
  const board = createBoard();
  lockPiece(board, { type: 'L', rotation: 0, x: 0, y: 20 });
  assert.equal(board.cells[20][2], 3);
  assert.deepEqual([...board.cells[21].slice(0, 4)], [3, 3, 3, 0]);
});

test('findFullRows returns filled rows ascending', () => {
  const board = createBoard();
  fillRow(board, 21);
  fillRow(board, 5);
  board.cells[10].fill(2);
  board.cells[10][3] = 0;
  assert.deepEqual(findFullRows(board), [5, 21]);
});

test('clearRows handles non-contiguous rows and shifts the stack down', () => {
  const board = createBoard();
  fillRow(board, 5);
  fillRow(board, 7);
  board.cells[4][0] = 2;   // above both → drops 2
  board.cells[6][1] = 3;   // between → drops 1
  board.cells[8][2] = 4;   // below both → stays
  assert.equal(clearRows(board, [7, 5]), 2);
  assert.equal(board.cells.length, ROWS);
  assert.equal(board.cells[6][0], 2);
  assert.equal(board.cells[7][1], 3);
  assert.equal(board.cells[8][2], 4);
  assert.deepEqual(findFullRows(board), []);
  assert.ok(board.cells[0] instanceof Uint8Array && board.cells[0].every((v) => v === 0));
  assert.ok(board.cells[1].every((v) => v === 0));
});

test('clearRows: tetris on the floor', () => {
  const board = createBoard();
  for (let y = 18; y < 22; y++) fillRow(board, y);
  board.cells[17][9] = 1;
  assert.equal(clearRows(board, findFullRows(board)), 4);
  assert.equal(board.cells[21][9], 1);
  assert.equal(board.cells.flatMap((r) => [...r]).filter(Boolean).length, 1);
});

test('isLockOut: true only when every cell is in the hidden rows', () => {
  assert.ok(isLockOut(spawnPiece('T')));                          // rows 0–1
  assert.ok(!isLockOut({ type: 'T', rotation: 0, x: 3, y: 1 }));  // bottom row at 2 (visible)
  assert.equal(HIDDEN_ROWS, 2);
});

test('dropDistance: to floor on empty board, onto stack otherwise', () => {
  const board = createBoard();
  assert.equal(dropDistance(board, spawnPiece('T')), 20);  // T bottom row y+1 → 21
  assert.equal(dropDistance(board, spawnPiece('I')), 20);  // I row y+1 → 21
  fillRow(board, 21);
  assert.equal(dropDistance(board, spawnPiece('T')), 19);
  assert.equal(dropDistance(board, { type: 'T', rotation: 0, x: 3, y: 19 }), 0);
});
