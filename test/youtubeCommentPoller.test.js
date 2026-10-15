import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import SocialComment from '../src/models/SocialComment.js';
import { collectNewYoutubeComments } from '../src/services/youtubeCommentPoller.js';

const account = { _id: new mongoose.Types.ObjectId(), accountId: 'UCchannel' };
const thread = (id, minutesAgo, extra = {}) => ({
  id,
  text: `comment ${id}`,
  username: 'viewer',
  fromId: 'UCviewer',
  timestamp: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
  mediaId: 'vid00000001',
  replies: [],
  ...extra,
});

test('first poll only backfills and never automates old comments', async (t) => {
  t.mock.method(SocialComment, 'updateOne', async () => ({ upsertedCount: 1 }));
  const toAutomate = await collectNewYoutubeComments(account, [thread('a', 1)], { lastPolledAt: null });
  assert.deepEqual(toAutomate, []);
});

test('later polls automate new top-level comments from other people only', async (t) => {
  const writes = [];
  t.mock.method(SocialComment, 'updateOne', async (filter, update) => { writes.push({ filter, update }); return {}; });
  const lastPolledAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const toAutomate = await collectNewYoutubeComments(account, [
    thread('new', 1, {
      replies: [
        { id: 'new.r1', text: 'thanks!', username: 'mychannel', fromId: 'UCchannel', timestamp: new Date().toISOString() },
        { id: 'new.r2', text: 'me too', username: 'other', fromId: 'UCother', timestamp: new Date().toISOString() },
      ],
    }),
    thread('old', 120),
    thread('mine', 1, { fromId: 'UCchannel' }),
  ], { lastPolledAt });

  assert.deepEqual(toAutomate.map((comment) => comment.commentId), ['new']);
  assert.equal(toAutomate[0].platform, 'youtube');
  assert.equal(toAutomate[0].entryId, 'UCchannel');
  // The channel's own reply marks its parent as replied instead of being stored
  assert.ok(writes.some((write) => write.filter.commentId === 'new' && write.update.$set?.ownerReplied === true));
  assert.ok(!writes.some((write) => write.filter.commentId === 'mine'));
  assert.ok(writes.some((write) => write.filter.commentId === 'new.r2' && write.update.$setOnInsert.parentId === 'new'));
});
