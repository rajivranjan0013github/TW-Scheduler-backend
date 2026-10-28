import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import SocialComment from '../src/models/SocialComment.js';
import SocialAccount from '../src/models/SocialAccount.js';
import AutomationEvent from '../src/models/AutomationEvent.js';
import AutomationRule from '../src/models/AutomationRule.js';
import User from '../src/models/User.js';
import { purgeExpiredYoutubeEngagement } from '../src/services/engagementRetentionService.js';
import { processStoredComment } from '../src/services/commentAutomationService.js';
import { removeAutomationJobsForAccounts } from '../src/services/automationJobPrivacy.js';
import { visibleEngagementFilter, youtubeEngagementExpiry } from '../src/utils/engagementRetention.js';

test('YouTube retention applies only to YouTube and expires data 30 days after collection', () => {
  const collected = new Date('2026-01-01T00:00:00Z');
  assert.deepEqual(youtubeEngagementExpiry('youtube', collected), {
    youtubeDataExpiresAt: new Date('2026-01-31T00:00:00Z'),
  });
  assert.deepEqual(youtubeEngagementExpiry('instagram', collected), {});
  for (const model of [SocialComment, AutomationEvent]) {
    assert.ok(model.schema.indexes().some(([fields, options]) => (
      fields.youtubeDataExpiresAt === 1 && options.expireAfterSeconds === 0
    )));
  }
});

test('cleanup handles legacy records without expiry and never extends their collection date', async (t) => {
  const now = new Date('2026-02-15T00:00:00Z');
  const deletes = [];
  const migrations = [];
  for (const model of [SocialComment, AutomationEvent]) {
    t.mock.method(model, 'deleteMany', async (filter) => { deletes.push(filter); return { deletedCount: 2 }; });
    t.mock.method(model, 'updateMany', async (...args) => { migrations.push(args); return {}; });
  }
  assert.equal(await purgeExpiredYoutubeEngagement(now), 4);
  for (const filter of deletes) {
    assert.equal(filter.platform, 'youtube');
    assert.deepEqual(filter.$or[0], { youtubeDataExpiresAt: { $lte: now } });
    assert.deepEqual(filter.$or[1], {
      youtubeDataExpiresAt: null, createdAt: { $lte: new Date('2026-01-16T00:00:00Z') },
    });
  }
  for (const [filter, pipeline, options] of migrations) {
    assert.equal(filter.platform, 'youtube');
    assert.equal(pipeline[0].$set.youtubeDataExpiresAt.$add[0], '$createdAt');
    assert.equal(options.timestamps, false);
  }
});

test('expiry filtering hides stale YouTube data before TTL deletion and retains Meta data', () => {
  const now = new Date('2026-02-15T00:00:00Z');
  const filter = visibleEngagementFilter(now);
  assert.deepEqual(filter.$or[0], { platform: { $ne: 'youtube' } });
  assert.deepEqual(filter.$or[1], { youtubeDataExpiresAt: { $gt: now } });
  assert.deepEqual(filter.$or[2].createdAt, { $gt: new Date('2026-01-16T00:00:00Z') });
});

test('a queued record reference does nothing after its account is disconnected', async (t) => {
  let commentRead = false;
  t.mock.method(SocialAccount, 'findOne', async (filter) => {
    assert.equal(filter.isConnected, true);
    return null;
  });
  t.mock.method(SocialComment, 'findOne', async () => { commentRead = true; });
  assert.deepEqual(await processStoredComment({ socialAccountId: 'account', socialCommentId: 'record' }), { handled: 0 });
  assert.equal(commentRead, false);
});

test('a queued record reference does nothing when the comment was deleted or expired', async (t) => {
  t.mock.method(User, 'exists', async () => true);
  t.mock.method(SocialAccount, 'findOne', async () => ({ _id: 'account', userId: 'owner' }));
  t.mock.method(SocialComment, 'findOne', async (filter) => {
    assert.ok(filter.$or.some((condition) => condition.youtubeDataExpiresAt?.$gt));
    return null;
  });
  assert.deepEqual(await processStoredComment({ socialAccountId: 'account', socialCommentId: 'record' }), { handled: 0 });
});

test('record references preserve keyword matching and target only the intended connected account', async (t) => {
  let eventsCreated = 0;
  const accountId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  const account = { _id: accountId, platform: 'youtube', accountId: 'UCowner', userId: 'owner' };
  t.mock.method(User, 'exists', async () => true);
  t.mock.method(SocialAccount, 'findOne', async () => account);
  t.mock.method(SocialAccount, 'find', async () => [account, { ...account, _id: otherId }]);
  t.mock.method(SocialComment, 'findOne', async () => ({
    commentId: 'comment', mediaId: 'video', text: 'please send LINK', username: 'viewer', commenterId: 'UCviewer',
  }));
  t.mock.method(AutomationRule, 'find', (filter) => ({ sort: async () => {
    assert.equal(String(filter.socialAccountId), String(accountId));
    return [{
      _id: 'rule', enabled: true, mediaScope: 'all', triggerType: 'keywords', keywords: ['link'], commentReplies: ['Thanks'],
    }];
  } }));
  t.mock.method(AutomationEvent, 'create', async (event) => {
    eventsCreated += 1;
    assert.equal(event.commenterId, 'UCviewer');
    assert.equal(event.commentText, 'please send LINK');
    assert.ok(event.youtubeDataExpiresAt instanceof Date);
    const duplicate = new Error('already handled');
    duplicate.code = 11000;
    throw duplicate; // Stop before any provider access.
  });
  assert.deepEqual(await processStoredComment({ socialAccountId: accountId, socialCommentId: 'record' }), { handled: 0 });
  assert.equal(eventsCreated, 1);
});

const fakeJob = (data, state = 'delayed') => ({
  data, removed: false,
  getState: async () => state,
  async updateData(next) { this.data = next; },
  async remove() { this.removed = true; },
});
const account = { _id: 'account', platform: 'instagram', accountId: 'app-id', metadata: { instagramProfessionalId: 'professional-id' } };

test('deletion clears reference and legacy jobs without touching other accounts or platforms', async () => {
  const matching = [
    fakeJob({ socialAccountId: 'account', socialCommentId: 'record' }),
    fakeJob({ comment: { entryId: 'professional-id', text: 'private text' } }, 'completed'),
    fakeJob({ comment: { entryId: 'app-id', text: 'failed text' } }, 'failed'),
  ];
  const unrelated = [
    fakeJob({ socialAccountId: 'other', socialCommentId: 'record' }),
    fakeJob({ comment: { platform: 'facebook', entryId: 'app-id', text: 'another platform' } }),
  ];
  await removeAutomationJobsForAccounts({ getJobs: async () => [...matching, ...unrelated] }, [account]);
  assert.ok(matching.every((job) => job.removed));
  assert.ok(matching.every((job) => job.data.cancelled && !job.data.comment && !job.data.socialCommentId));
  assert.ok(unrelated.every((job) => !job.removed));
});

test('active legacy payloads are scrubbed but unfinished work prevents deletion from reporting success', async () => {
  const job = fakeJob({ comment: { entryId: 'app-id', text: 'private text' } }, 'active');
  await assert.rejects(removeAutomationJobsForAccounts({ getJobs: async () => [job] }, [account], { timeoutMs: 0 }), /Retry/);
  assert.deepEqual(job.data, { socialAccountId: 'account', cancelled: true });
  assert.equal(job.removed, false);
  // The scrubbed job must remain discoverable when the caller retries deletion.
  job.getState = async () => 'completed';
  await removeAutomationJobsForAccounts({ getJobs: async () => [job] }, [account]);
  assert.equal(job.removed, true);
});

test('deletion waits for active work to finish before removing its job', async () => {
  const job = fakeJob({ socialAccountId: 'account' });
  let checks = 0;
  job.getState = async () => ++checks <= 2 ? 'active' : 'completed';
  await removeAutomationJobsForAccounts({ getJobs: async () => [job] }, [account]);
  assert.ok(job.removed);
  assert.ok(checks >= 3);
});
