import { Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import { publishPostJob } from './publisherWorker.js';
import { runFeedSync } from './feedSyncWorker.js';
import { runManualAccountSync, runMetricSync } from './metricSyncWorker.js';
import MetricSyncStatus from '../models/MetricSyncStatus.js';
import { runTokenHealthCheck } from '../services/tokenHealthService.js';

let publishQueue = null;
let feedSyncQueue = null;
let insightSyncQueue = null;
let metricSyncQueue = null;
let accountSyncQueue = null;
let tokenHealthQueue = null;
let intervalFallbackId = null;
let feedSyncIntervalId = null;
let insightSyncIntervalId = null;
let hotMetricSyncIntervalId = null;
let warmMetricSyncIntervalId = null;
let tokenHealthIntervalId = null;
let publishQueueReconcileIntervalId = null;
let publishQueueReconcileRunning = false;

const PUBLISH_QUEUE_RECONCILE_INTERVAL_MS = 30 * 1000;

const shouldHavePublishJob = (post) => (
  ['auto', 'hybrid'].includes(post?.scheduleMode || 'auto')
  && post?.status === 'scheduled'
);

const getPostJobDelay = (post) => {
  const scheduledAtMs = new Date(post?.scheduledAt).getTime();
  if (!Number.isFinite(scheduledAtMs)) {
    throw new Error('Cannot queue a post without a valid scheduled date.');
  }
  return Math.max(0, scheduledAtMs - Date.now());
};

export const isBackgroundSyncEnabled = () => {
  if (process.env.ENABLE_BACKGROUND_SYNC !== undefined) {
    return process.env.ENABLE_BACKGROUND_SYNC === 'true';
  }
  return process.env.NODE_ENV === 'production';
};

export const initQueue = async () => {
  const connection = getRedisConnection();
  const backgroundSyncActive = isBackgroundSyncEnabled();

  if (connection) {
    publishQueue = new Queue('publishing-queue', {
      connection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      }
    });

    accountSyncQueue = new Queue('account-sync-queue', {
      connection,
      defaultJobOptions: {
        attempts: 4,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
      },
    });

    if (backgroundSyncActive) {
      // Feed Sync Queue — runs every 2 hours
      feedSyncQueue = new Queue('feed-sync-queue', {
        connection,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
      });
      await feedSyncQueue.add('feed-sync', {}, {
        repeat: { pattern: '0 */2 * * *' }, // Every 2 hours
        jobId: 'feed-sync-repeatable',
      });
      await feedSyncQueue.add('startup-sync', { startupFullSync: true }, { jobId: 'sync-startup' });

      metricSyncQueue = new Queue('metric-sync-queue', {
        connection,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
      });
      await metricSyncQueue.add('metric-sync', { tier: 'hot' }, {
        repeat: { pattern: '*/30 * * * *' },
        jobId: 'metric-sync-hot-repeatable',
      });
      await metricSyncQueue.add('metric-sync', { tier: 'warm' }, {
        repeat: { pattern: '10 */2 * * *' },
        jobId: 'metric-sync-warm-repeatable',
      });

      // Full 30-day metric sync — runs daily at 2:00 AM IST (20:30 UTC)
      insightSyncQueue = new Queue('insight-sync-queue', {
        connection,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
      });
      await insightSyncQueue.add('insight-sync', { tier: 'daily' }, {
        repeat: { pattern: '30 20 * * *' }, // 20:30 UTC = 2:00 AM IST
        jobId: 'insight-sync-repeatable',
      });

      tokenHealthQueue = new Queue('token-health-queue', {
        connection,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
      });
      await tokenHealthQueue.add('token-health', {}, {
        repeat: { pattern: '0 */12 * * *' }, // Every 12 hours
        jobId: 'token-health-repeatable',
      });
    } else {
      console.info('[Queue] Background sync queues disabled (ENABLE_BACKGROUND_SYNC is false).');
    }

    startPublishQueueReconciler();
  } else {
    startIntervalFallback();
    if (backgroundSyncActive) {
      startSyncFallbacks();
    } else {
      console.info('[Fallback] Background sync intervals disabled (ENABLE_BACKGROUND_SYNC is false).');
    }
  }
};

export const requestAccountSync = async (accountId) => {
  const normalizedId = String(accountId || '');
  if (!normalizedId) throw new Error('Account ID is required.');
  await MetricSyncStatus.findOneAndUpdate(
    { accountId: normalizedId, tier: 'manual' },
    { $set: { status: 'queued', lastAttemptAt: new Date(), lastError: '' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  if (accountSyncQueue) {
    const jobId = `account-sync-${normalizedId}`;
    const existing = await accountSyncQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (['waiting', 'active', 'delayed', 'prioritized'].includes(state)) {
        console.info('[Manual Sync] request_deduplicated', { accountId: normalizedId, jobId, state, timestamp: new Date().toISOString() });
        return { queued: true, deduplicated: true, jobId };
      }
      await existing.remove();
    }
    await accountSyncQueue.add('account-sync', { accountId: normalizedId }, { jobId, priority: 1 });
    console.info('[Manual Sync] request_queued', { accountId: normalizedId, jobId, timestamp: new Date().toISOString() });
    return { queued: true, deduplicated: false, jobId };
  }

  void (async () => {
    try {
      await runManualAccountSync(normalizedId);
    } catch (error) {
      console.error(`[Manual Sync] Account ${normalizedId} failed:`, error.message);
      await MetricSyncStatus.findOneAndUpdate(
        { accountId: normalizedId, tier: 'manual' },
        { $set: { status: 'failed', lastError: String(error.message || error).slice(0, 500) } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      ).catch((statusError) => console.error('Failed to record manual sync status:', statusError.message));
    }
  })();
  console.info('[Manual Sync] fallback_started', { accountId: normalizedId, timestamp: new Date().toISOString() });
  return { queued: true, deduplicated: false, jobId: null, fallback: true };
};

export const addPostToQueue = async (post) => {
  await syncPostInQueue(post);
};

export const syncPostInQueue = async (post) => {
  if (!publishQueue || !post?._id) return { synced: false, reason: 'queue_unavailable' };

  const jobId = post._id.toString();
  const existingJob = await publishQueue.getJob(jobId);

  if (!shouldHavePublishJob(post)) {
    if (!existingJob) return { synced: true, action: 'none' };
    const state = await existingJob.getState();
    if (state === 'active') {
      const error = new Error('This post is already publishing and can no longer be edited.');
      error.code = 'PUBLISH_JOB_ACTIVE';
      throw error;
    }
    await existingJob.remove();
    return { synced: true, action: 'removed' };
  }

  const delay = getPostJobDelay(post);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state === 'active') {
      const error = new Error('This post is already publishing and can no longer be rescheduled.');
      error.code = 'PUBLISH_JOB_ACTIVE';
      throw error;
    }
    if (state === 'delayed') {
      await existingJob.changeDelay(delay);
      return { synced: true, action: 'rescheduled' };
    }
    await existingJob.remove();
  }

  await publishQueue.add('publish-post',
    { postId: post._id },
    { delay, jobId }
  );
  return { synced: true, action: 'added' };
};

export const assertPostQueueEditable = async (post) => {
  if (post?.status === 'publishing') {
    const error = new Error('This post is already publishing and can no longer be edited.');
    error.code = 'PUBLISH_JOB_ACTIVE';
    throw error;
  }
  if (!publishQueue || !post?._id) return;
  const job = await publishQueue.getJob(post._id.toString());
  if (job && await job.getState() === 'active') {
    const error = new Error('This post is already publishing and can no longer be edited.');
    error.code = 'PUBLISH_JOB_ACTIVE';
    throw error;
  }
};

export const removePostFromQueue = async (postId) => {
  if (publishQueue) {
    const job = await publishQueue.getJob(postId.toString());
    if (job) {
      await job.remove();
    }
  }
};

const reconcilePublishQueue = async () => {
  if (!publishQueue || !getDBStatus() || publishQueueReconcileRunning) return;
  publishQueueReconcileRunning = true;
  try {
    const scheduledPosts = await ScheduledPost.find({
      status: 'scheduled',
      $or: [
        { scheduleMode: { $in: ['auto', 'hybrid'] } },
        { scheduleMode: { $exists: false } },
      ],
    }).select('_id scheduledAt scheduleMode status');

    const results = await Promise.allSettled(
      scheduledPosts.map((post) => syncPostInQueue(post))
    );
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    if (failedCount > 0) {
      console.error(`Publish queue reconciliation failed for ${failedCount} post(s).`);
    }
  } catch (error) {
    console.error('Publish queue reconciliation failed:', error.message);
  } finally {
    publishQueueReconcileRunning = false;
  }
};

const startPublishQueueReconciler = () => {
  if (publishQueueReconcileIntervalId) clearInterval(publishQueueReconcileIntervalId);
  publishQueueReconcileIntervalId = setInterval(() => {
    void reconcilePublishQueue();
  }, PUBLISH_QUEUE_RECONCILE_INTERVAL_MS);
};

const startIntervalFallback = () => {
  if (intervalFallbackId) clearInterval(intervalFallbackId);

  // Check every 10 seconds for scheduled posts
  intervalFallbackId = setInterval(async () => {
    const now = new Date();
    const isConnected = getDBStatus();

    if (!isConnected) {
      // Process mockStore scheduled posts
      const postsToPublish = mockStore.scheduledPosts.filter(
        p => p.status === 'scheduled'
          && ['auto', 'hybrid'].includes(p.scheduleMode || 'auto')
          && new Date(p.scheduledAt) <= now
      );

      for (const post of postsToPublish) {
        post.status = 'publishing';
        
        // Run publishing job simulation
        setTimeout(async () => {
          try {
            await publishPostJob(post._id);
          } catch (err) {
            console.error('Sandbox publication failed:', err.message);
          }
        }, 1000);
      }
    } else {
      // Process connected MongoDB posts
      try {
        const postsToPublish = await ScheduledPost.find({
          status: 'scheduled',
          $or: [
            { scheduleMode: { $in: ['auto', 'hybrid'] } },
            { scheduleMode: { $exists: false } },
          ],
          scheduledAt: { $lte: now }
        });

        for (const post of postsToPublish) {
          post.status = 'publishing';
          await post.save();
          
          setTimeout(async () => {
            try {
              await publishPostJob(post._id);
            } catch (err) {
              console.error('DB Cron publication failed:', err.message);
            }
          }, 1000);
        }
      } catch (error) {
        console.error('Error in local database queue poll:', error.message);
      }
    }
  }, 10000); // 10 seconds check
};

/**
 * Fallback interval-based sync schedulers for when Redis is not available.
 * Feed discovery: every 2 hours. Metrics: hot every 30 minutes,
 * latest 14 every 2 hours, and all posts from the last 30 days daily.
 */
const startSyncFallbacks = () => {
  const runSafely = (label, task) => {
    void task().catch((error) => console.error(`[Fallback] ${label} error:`, error.message));
  };

  // Run once on startup in sequence: discover posts first, then perform one
  // comprehensive metric pass. Hot/warm jobs begin on their normal schedules.
  runSafely('Startup sync', async () => {
    await runFeedSync();
    await runMetricSync('daily');
  });

  // Feed Sync fallback — every 2 hours
  if (feedSyncIntervalId) clearInterval(feedSyncIntervalId);
  feedSyncIntervalId = setInterval(async () => {
    try {
      await runFeedSync();
    } catch (err) {
      console.error('❌ [Fallback] Feed sync error:', err.message);
    }
  }, 2 * 60 * 60 * 1000); // 2 hours

  if (hotMetricSyncIntervalId) clearInterval(hotMetricSyncIntervalId);
  hotMetricSyncIntervalId = setInterval(() => {
    runSafely('Hot metric sync', () => runMetricSync('hot'));
  }, 30 * 60 * 1000);

  if (warmMetricSyncIntervalId) clearInterval(warmMetricSyncIntervalId);
  warmMetricSyncIntervalId = setInterval(() => {
    runSafely('Warm metric sync', () => runMetricSync('warm'));
  }, 2 * 60 * 60 * 1000);

  // Full 30-day metric sync fallback — every 24 hours
  if (insightSyncIntervalId) clearInterval(insightSyncIntervalId);
  insightSyncIntervalId = setInterval(async () => {
    try {
      await runMetricSync('daily');
    } catch (err) {
      console.error('[Fallback] Daily metric sync error:', err.message);
    }
  }, 24 * 60 * 60 * 1000); // 24 hours

  // Token health fallback — every 12 hours
  if (tokenHealthIntervalId) clearInterval(tokenHealthIntervalId);
  tokenHealthIntervalId = setInterval(async () => {
    try {
      await runTokenHealthCheck();
    } catch (err) {
      console.error('❌ [Fallback] Token health error:', err.message);
    }
  }, 12 * 60 * 60 * 1000); // 12 hours
};
