import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PublishedPost from '../src/models/PublishedPost.js';
import { purgeExpiredYoutubeCache } from '../src/queues/feedSyncWorker.js';

test('PublishedPost schema defines youtubeDataExpiresAt with a TTL index', () => {
  const schema = PublishedPost.schema;
  assert.ok(schema.paths.youtubeDataExpiresAt, 'PublishedPost must have youtubeDataExpiresAt field');
  
  const indexes = schema.indexes();
  const ttlIndex = indexes.find(
    ([fields, options]) => fields.youtubeDataExpiresAt === 1 && options?.expireAfterSeconds === 0
  );
  assert.ok(ttlIndex, 'PublishedPost must have a TTL index on youtubeDataExpiresAt with expireAfterSeconds: 0');
});

test('purgeExpiredYoutubeCache function is exported and callable', async () => {
  assert.equal(typeof purgeExpiredYoutubeCache, 'function');
  // When DB is not connected in standalone unit test, it safely returns 0
  const result = await purgeExpiredYoutubeCache();
  assert.equal(typeof result, 'number');
});

test('PublishedPost accepts youtubeDataExpiresAt and serializes properly', () => {
  const testDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const postDoc = new PublishedPost({
    userId: new mongoose.Types.ObjectId(),
    accountId: new mongoose.Types.ObjectId(),
    metaPostId: 'yt_video_123',
    platform: 'youtube',
    content: 'Test YouTube Video',
    latestViews: 500,
    latestLikes: 25,
    latestComments: 5,
    youtubeDataExpiresAt: testDate,
  });

  assert.equal(postDoc.platform, 'youtube');
  assert.equal(postDoc.latestViews, 500);
  assert.equal(postDoc.youtubeDataExpiresAt.getTime(), testDate.getTime());
});
