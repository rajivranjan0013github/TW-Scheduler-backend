import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFacebookAnalyticsStatus } from '../src/queues/metricSyncWorker.js';

test('one inaccessible Facebook post does not override successful analytics access', () => {
  const result = resolveFacebookAnalyticsStatus([
    ['old-post', { engagementErrorType: 'permission_missing' }],
    ['current-post', { engagementErrorType: '' }],
  ]);

  assert.deepEqual(result, { status: 'healthy', error: '' });
});

test('Facebook analytics permission is missing when every engagement request is denied', () => {
  const result = resolveFacebookAnalyticsStatus([
    ['post-1', { engagementErrorType: 'permission_missing' }],
    ['post-2', { engagementErrorType: 'permission_missing' }],
  ]);

  assert.equal(result.status, 'permission_missing');
  assert.match(result.error, /pages_read_engagement/);
});

test('temporary Facebook analytics failures are not presented as missing permission', () => {
  const result = resolveFacebookAnalyticsStatus([
    ['post-1', { engagementErrorType: 'unavailable' }],
  ]);

  assert.equal(result.status, 'unavailable');
});
