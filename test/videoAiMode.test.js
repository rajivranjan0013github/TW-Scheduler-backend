import test from 'node:test';
import assert from 'node:assert/strict';
import { determineMediaAiMode } from '../src/services/videoAiService.js';

test('determineMediaAiMode respects explicit overrides', async () => {
  assert.equal(await determineMediaAiMode({}, 'app_showcase'), 'app_showcase');
  assert.equal(await determineMediaAiMode({}, 'reaction'), 'reaction');
});

test('determineMediaAiMode identifies app showcase from media tags', async () => {
  assert.equal(await determineMediaAiMode({ tags: ['app-showcase', 'mobile'] }), 'app_showcase');
  assert.equal(await determineMediaAiMode({ tags: ['promo', 'ios'] }), 'app_showcase');
  assert.equal(await determineMediaAiMode({ tags: ['showcase'] }), 'app_showcase');
});

test('determineMediaAiMode identifies reaction from media tags', async () => {
  assert.equal(await determineMediaAiMode({ tags: ['hooks', 'creator'] }), 'reaction');
  assert.equal(await determineMediaAiMode({ tags: ['hook'] }), 'reaction');
});

test('determineMediaAiMode defaults to reaction when unclassified', async () => {
  assert.equal(await determineMediaAiMode({ tags: ['general'] }), 'reaction');
  assert.equal(await determineMediaAiMode({}), 'reaction');
});
