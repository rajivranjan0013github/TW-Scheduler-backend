import test from 'node:test';
import assert from 'node:assert/strict';

import { compileDeterministicTasks } from '../src/services/bulkAgentService.js';

const folders = [
  { _id: 'folder-primary', name: 'Products', typeCounts: { video: 50, audio: 0 } },
  { _id: 'folder-secondary', name: 'People', typeCounts: { video: 50, audio: 0 } },
  { _id: 'folder-audio', name: 'Trending songs', typeCounts: { video: 0, audio: 50 } },
];
const mentions = [
  { folderId: 'folder-primary', name: 'Products', role: 'primary' },
  { folderId: 'folder-secondary', name: 'People', role: 'secondary' },
  { folderId: 'folder-audio', name: 'Trending songs', role: 'audio' },
];
const currentBoard = {
  rows: Array.from({ length: 12 }, (_, index) => ({
    rowId: `row-${index + 1}`,
    index,
    caption: `Caption ${index + 1}`,
  })),
};

const cases = [
  ...Array.from({ length: 15 }, (_, index) => ({
    name: `create frames wording ${index + 1}`,
    message: `${['Create', 'Make', 'Generate'][index % 3]} ${index + 1} new ${index % 2 ? 'frames' : 'variations'}`,
    expectedType: 'createFrames',
    expectedCount: index + 1,
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    name: `remove targeted frame ${index + 1}`,
    message: `${index % 2 ? 'Delete' : 'Remove'} frame ${index + 1}`,
    expectedType: 'removeFrames',
    expectedFrames: [index + 1],
  })),
  ...[
    'Clear the board', 'Clear all frames', 'Delete the board', 'Remove all frames', 'Clear all rows',
  ].map((message, index) => ({ name: `clear board wording ${index + 1}`, message, expectedType: 'clearBoard' })),
  ...Array.from({ length: 5 }, (_, index) => ({
    name: `remove audio target ${index + 1}`,
    message: `Remove background music from frame ${index + 1}`,
    expectedType: 'removeAudio',
    expectedFrames: [index + 1],
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    name: `remove text target ${index + 1}`,
    message: `Remove caption from frame ${index + 1}`,
    expectedType: 'removeText',
    expectedFrames: [index + 1],
  })),
  ...[
    ['Move all captions to the top', 'top'],
    ['Move every caption to the bottom', 'bottom'],
    ['Position all captions on the left', 'left'],
    ['Position every caption on the right', 'right'],
    ['Move all captions to the center', 'center'],
  ].map(([message, preset], index) => ({
    name: `position captions wording ${index + 1}`, message, expectedType: 'setTextPosition', expectedPreset: preset,
  })),
  ...[
    { message: 'Set the first video on all frames from @Products', expectedType: 'setFirstVideo' },
    { message: 'Replace every first clip using @Products', expectedType: 'setFirstVideo' },
    { message: 'Set the second video on all frames from @People', expectedType: 'setSecondVideo' },
    { message: 'Replace every second clip using @People', expectedType: 'setSecondVideo' },
    { message: 'Set audio on all frames from @Trending songs', expectedType: 'setAudio' },
  ].map((entry, index) => ({ name: `folder role wording ${index + 1}`, ...entry })),
];

test('50-prompt Bulk Builder intent evaluation set', async (t) => {
  assert.equal(cases.length, 50);
  for (const promptCase of cases) {
    await t.test(promptCase.name, () => {
      const tasks = compileDeterministicTasks({
        message: promptCase.message,
        folders,
        mentionedFolders: mentions,
        isDualVideo: true,
        currentBoard,
      });
      const task = tasks.find((candidate) => candidate.type === promptCase.expectedType);
      assert.ok(task, `${promptCase.message} should compile ${promptCase.expectedType}; got ${tasks.map(({ type }) => type).join(', ')}`);
      if (promptCase.expectedCount) assert.equal(task.params.count, promptCase.expectedCount);
      if (promptCase.expectedFrames) assert.deepEqual(task.target.frameNumbers, promptCase.expectedFrames);
      if (promptCase.expectedPreset) assert.equal(task.params.position.preset, promptCase.expectedPreset);
    });
  }
});
