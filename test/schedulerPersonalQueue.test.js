import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { getSchedulerPostListQuery } from '../src/routes/scheduler.js';

test('getSchedulerPostListQuery includes campaignId when provided', () => {
  const campaignId = new mongoose.Types.ObjectId().toString();
  const query = getSchedulerPostListQuery(campaignId, {
    accountIds: 'acc1,acc2',
    statuses: 'scheduled,published',
  });

  assert.equal(query.campaignId, campaignId);
  assert.deepEqual(query.status, { $in: ['scheduled', 'published'] });
  assert.ok(query.$or.some((clause) => clause.socialAccountIds?.$in?.includes('acc1')));
});

test('getSchedulerPostListQuery omits campaignId when not provided for personal channel query', () => {
  const query = getSchedulerPostListQuery(null, {
    accountIds: 'acc123',
    statuses: 'scheduled,manual_ready',
  });

  assert.equal(query.campaignId, undefined);
  assert.deepEqual(query.status, { $in: ['scheduled', 'manual_ready'] });
  assert.ok(query.$or.some((clause) => clause.socialAccountIds?.$in?.includes('acc123')));
});

test('getSchedulerPostListQuery handles includeManualPostedRange without campaignId', () => {
  const query = getSchedulerPostListQuery(undefined, {
    accountIds: 'acc456',
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-07T23:59:59.999Z',
    includeManualPostedRange: 'true',
  });

  assert.equal(query.campaignId, undefined);
  assert.ok(Array.isArray(query.$and));
  assert.ok(query.$or.some((clause) => clause.socialAccountIds?.$in?.includes('acc456')));
});
