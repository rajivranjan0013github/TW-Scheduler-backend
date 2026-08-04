import { Worker } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import SocialAccount from '../models/SocialAccount.js';
import Media from '../models/Media.js';
import { publishCarouselToInstagram, publishToInstagram, publishToFacebook } from '../services/metaService.js';
import { runFeedSync } from './feedSyncWorker.js';
import { runManualAccountSync, runMetricSync } from './metricSyncWorker.js';
import { publishToYoutube } from '../services/youtubeService.js';
import { ensureFreshAccountToken, handleProviderAuthFailure, runTokenHealthCheck } from '../services/tokenHealthService.js';
import MetricSyncStatus from '../models/MetricSyncStatus.js';

// Setup BullMQ workers if Redis is connected
let worker = null;
let feedSyncWorker = null;
let insightSyncWorker = null;
let metricSyncWorker = null;
let accountSyncWorker = null;
let tokenHealthWorker = null;

export const initWorker = () => {
  const connection = getRedisConnection();

  if (connection) {
    worker = new Worker('publishing-queue', async (job) => {
      const { postId } = job.data;
      await publishPostJob(postId);
    }, { connection });

    worker.on('completed', (job) => {
    });

    worker.on('failed', (job, err) => {
      console.error(`❌ Job ${job.id} failed with error: ${err.message}`);
    });

    // Feed Sync Worker — processes feed-sync jobs every 2 hours
    feedSyncWorker = new Worker('feed-sync-queue', async (job) => {
      await runFeedSync();
      if (job.data?.startupFullSync) {
        await runMetricSync('daily');
      }
    }, { connection });

    feedSyncWorker.on('completed', (job) => {
    });

    feedSyncWorker.on('failed', (job, err) => {
      console.error(`❌ Feed sync job ${job.id} failed: ${err.message}`);
    });

    metricSyncWorker = new Worker('metric-sync-queue', async (job) => {
      await runMetricSync(job.data?.tier || 'warm');
    }, { connection, concurrency: 2 });

    metricSyncWorker.on('failed', (job, err) => {
      console.error(`Metric sync job ${job.id} failed: ${err.message}`);
    });

    accountSyncWorker = new Worker('account-sync-queue', async (job) => {
      const { accountId } = job.data;
      return runManualAccountSync(accountId);
    }, {
      connection,
      concurrency: Math.max(1, Number(process.env.MANUAL_SYNC_CONCURRENCY) || 2),
    });

    accountSyncWorker.on('failed', async (job, err) => {
      console.error('[Manual Sync] job_attempt_failed', {
        jobId: job?.id,
        accountId: job?.data?.accountId,
        attempt: job?.attemptsMade,
        maxAttempts: Number(job?.opts?.attempts || 1),
        error: String(err.message || err).slice(0, 500),
        timestamp: new Date().toISOString(),
      });
      if (job && job.attemptsMade >= Number(job.opts.attempts || 1)) {
        const isRateLimited = Number(err?.status || err?.error?.code || 0) === 429;
        await MetricSyncStatus.findOneAndUpdate(
          { accountId: job.data.accountId, tier: 'manual' },
          { $set: {
            status: isRateLimited ? 'rate_limited' : 'failed',
            lastError: String(err.message || err).slice(0, 500),
          } },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        ).catch((statusError) => console.error('Failed to record manual sync status:', statusError.message));
      }
    });

    // Full 30-day sync worker — processes the daily insight queue.
    insightSyncWorker = new Worker('insight-sync-queue', async (job) => {
      await runMetricSync(job.data?.tier || 'daily');
    }, { connection });

    insightSyncWorker.on('completed', (job) => {
    });

    insightSyncWorker.on('failed', (job, err) => {
      console.error(`❌ Insight sync job ${job.id} failed: ${err.message}`);
    });

    tokenHealthWorker = new Worker('token-health-queue', async () => {
      await runTokenHealthCheck();
    }, { connection });

    tokenHealthWorker.on('failed', (job, err) => {
      console.error(`❌ Token health job ${job.id} failed: ${err.message}`);
    });
  }
};

/**
 * Shared job execution function
 * @param {string} postId 
 */
export const publishPostJob = async (postId) => {
  const isConnected = getDBStatus();
  let post = null;

  try {
    if (!isConnected) {
      post = mockStore.scheduledPosts.find(p => p._id === postId);
    } else {
      post = await ScheduledPost.findById(postId)
        .populate('socialAccountIds')
        .populate('mediaIds');
    }

    if (!post) {
      throw new Error(`Scheduled post not found: ${postId}`);
    }

    const mode = post.scheduleMode || 'auto';
    if (!['auto', 'hybrid'].includes(mode) || !['scheduled', 'publishing'].includes(post.status)) {
      return;
    }

    // MongoDB is the scheduling source of truth. If an older BullMQ job fires
    // after a reschedule, do not publish early; the queue reconciler will add
    // the job again for the updated time after this stale job completes.
    const scheduledAtMs = new Date(post.scheduledAt).getTime();
    if (post.status === 'scheduled' && Number.isFinite(scheduledAtMs) && scheduledAtMs > Date.now() + 1000) {
      return;
    }

    if (post.status === 'scheduled') {
      post.status = 'publishing';
      if (isConnected) {
        await post.save();
      } else {
        post.updatedAt = new Date();
      }
    }

    const format = (post.platformSpecifics?.type || 'reels').toLowerCase();

    // Verify social account and media exist
    let accounts = [];
    let mediaFiles = [];

    if (!isConnected) {
      accounts = mockStore.socialAccounts.filter(acc => post.socialAccountIds.includes(acc._id));
      mediaFiles = mockStore.media.filter(m => post.mediaIds.includes(m._id));
    } else {
      accounts = post.socialAccountIds;
      mediaFiles = post.mediaIds;
    }

    if (accounts.length === 0) {
      throw new Error('No social accounts connected to this scheduled post.');
    }

    // Success and response metadata
    const publishResponses = [];

    if (!isConnected) {
      // In sandbox/dev mode, we simulate network request latency.
      await new Promise(resolve => setTimeout(resolve, 3000));
      post.status = 'published_auto';
      post.publishSource = 'software';
      post.updatedAt = new Date();
    } else {
      // Call actual Meta API for each connected account
      for (const account of accounts) {
        let publishedId = null;
        const mainMedia = mediaFiles[0]; // Grab first attached media file if any
        const freshAccount = await ensureFreshAccountToken(account);

        try {
          if (freshAccount.platform === 'instagram') {
            if (!mainMedia) {
              throw new Error('Instagram requires an attached image or video file to publish.');
            }
            if (format === 'carousel') {
              publishedId = await publishCarouselToInstagram(
                freshAccount.accessToken,
                freshAccount.accountId,
                mediaFiles,
                post.caption,
                freshAccount.authProvider
              );
            } else {
              publishedId = await publishToInstagram(
                freshAccount.accessToken,
                freshAccount.accountId,
                mainMedia.url,
                mainMedia.type,
                post.caption,
                freshAccount.authProvider
              );
            }
          } else if (freshAccount.platform === 'facebook') {
            publishedId = await publishToFacebook(
              freshAccount.accessToken,
              freshAccount.accountId,
              mainMedia?.url,
              mainMedia?.type,
              post.caption
            );
          } else if (freshAccount.platform === 'youtube') {
            publishedId = await publishToYoutube({
              account: freshAccount,
              media: mainMedia,
              caption: post.caption,
              specifics: post.platformSpecifics,
            });
          } else {
            throw new Error(`Unsupported social platform: ${freshAccount.platform}`);
          }
        } catch (providerError) {
          await handleProviderAuthFailure(freshAccount, providerError, providerError.message);
          throw providerError;
        }

        publishResponses.push({
          accountId: freshAccount._id,
          platform: freshAccount.platform,
          publishId: publishedId,
        });
      }

      post.status = 'published_auto';
      post.publishSource = 'software';
      post.publishResponseId = JSON.stringify(publishResponses);
      await post.save();
    }

  } catch (error) {
    console.error(`❌ Error publishing post ${postId}:`, error.message);
    console.error(error.stack);
    if (post) {
      if (!isConnected) {
        post.status = 'failed';
        post.publishError = error.message;
        post.updatedAt = new Date();
      } else {
        post.status = 'failed';
        post.publishError = error.message;
        await post.save();
      }
    }
    throw error;
  }
};
