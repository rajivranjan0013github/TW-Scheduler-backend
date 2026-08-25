import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertBoardTargetsUnchanged,
  buildTargetRows,
} from '../src/routes/bulkAgent.js';
import { normalizeCurrentBoard } from '../src/services/bulkAgentService.js';

const rawBoard = {
  isDualVideo: true,
  rows: [
    {
      rowId: 'row-1',
      index: 0,
      video1MediaId: 'video-1a',
      video2MediaId: 'video-1b',
      audioMediaId: 'audio-1',
      caption: 'One',
    },
    {
      rowId: 'row-2',
      index: 1,
      video1MediaId: 'video-2a',
      video2MediaId: 'video-2b',
      audioMediaId: 'audio-2',
      caption: 'Two',
    },
  ],
};

test('target rows carry the complete immutable snapshot needed at Apply', () => {
  const currentBoard = normalizeCurrentBoard(rawBoard, 0, true);
  assert.deepEqual(buildTargetRows({
    intent: { operation: 'update', targetFrameNumbers: [2] },
    currentBoard,
  }), [currentBoard.rows[1]]);
});

test('unchanged targeted row passes apply-time validation', () => {
  const currentBoard = normalizeCurrentBoard(rawBoard, 0, true);
  const plan = {
    operation: 'update',
    isDualVideo: true,
    targetRows: [currentBoard.rows[1]],
  };

  assert.doesNotThrow(() => assertBoardTargetsUnchanged({
    plan,
    rawCurrentBoard: rawBoard,
  }));
});

test('changed or missing targeted row is rejected', () => {
  const currentBoard = normalizeCurrentBoard(rawBoard, 0, true);
  const plan = {
    operation: 'remove',
    isDualVideo: true,
    targetRows: [currentBoard.rows[1]],
  };
  const changedBoard = {
    ...rawBoard,
    rows: rawBoard.rows.map((row) => (
      row.rowId === 'row-2' ? { ...row, caption: 'Changed later' } : row
    )),
  };
  assert.throws(
    () => assertBoardTargetsUnchanged({ plan, rawCurrentBoard: changedBoard }),
    (error) => error.code === 'BOARD_CHANGED' && error.statusCode === 409,
  );
  assert.throws(
    () => assertBoardTargetsUnchanged({
      plan,
      rawCurrentBoard: { ...rawBoard, rows: rawBoard.rows.slice(0, 1) },
    }),
    (error) => error.code === 'BOARD_CHANGED' && error.statusCode === 409,
  );
});

test('clear and replace require an exact full-board snapshot', () => {
  const snapshot = normalizeCurrentBoard(rawBoard, 0, true).rows;
  ['clear', 'replace'].forEach((operation) => {
    const plan = { operation, isDualVideo: true, boardSnapshot: snapshot };
    assert.doesNotThrow(() => assertBoardTargetsUnchanged({
      plan,
      rawCurrentBoard: rawBoard,
    }));
    assert.throws(
      () => assertBoardTargetsUnchanged({
        plan,
        rawCurrentBoard: {
          ...rawBoard,
          rows: [...rawBoard.rows, { rowId: 'row-3', index: 2 }],
        },
      }),
      (error) => error.code === 'BOARD_CHANGED' && error.statusCode === 409,
    );
    assert.throws(
      () => assertBoardTargetsUnchanged({
        plan,
        rawCurrentBoard: { ...rawBoard, rows: [...rawBoard.rows].reverse() },
      }),
      (error) => error.code === 'BOARD_CHANGED' && error.statusCode === 409,
    );
  });
});

test('destructive and targeted plans require the current board at Apply', () => {
  ['update', 'remove', 'clear', 'replace'].forEach((operation) => {
    assert.throws(
      () => assertBoardTargetsUnchanged({
        plan: { operation, isDualVideo: true, targetRows: [], boardSnapshot: [] },
      }),
      (error) => error.code === 'CURRENT_BOARD_REQUIRED' && error.statusCode === 400,
    );
  });
});
