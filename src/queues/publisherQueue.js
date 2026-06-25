import { Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import { publishPostJob } from './publisherWorker.js';
import { runFeedSync } from './feedSyncWorker.js';
import { runInsightSync } from './insightSyncWorker.js';
import { runTokenHealthCheck } from '../services/tokenHealthService.js';

let publishQueue = null;
let feedSyncQueue = null;
let insightSyncQueue = null;
let tokenHealthQueue = null;
let intervalFallbackId = null;
let feedSyncIntervalId = null;
let insightSyncIntervalId = null;
let tokenHealthIntervalId = null;

export const initQueue = async () => {
  const connection = getRedisConnection();

  if (connection) {
    publishQueue = new Queue('publishing-queue', {
      connection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      }
    });

    // Feed Sync Queue — runs every 2 hours
    feedSyncQueue = new Queue('feed-sync-queue', {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
    });
    await feedSyncQueue.add('feed-sync', {}, {
      repeat: { pattern: '0 */2 * * *' }, // Every 2 hours
      jobId: 'feed-sync-repeatable',
    });

    // Insight Sync Queue — runs daily at 2:00 AM IST (20:30 UTC)
    insightSyncQueue = new Queue('insight-sync-queue', {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
    });
    await insightSyncQueue.add('insight-sync', {}, {
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
    startIntervalFallback();
    startSyncFallbacks();
  }
};

export const addPostToQueue = async (post) => {
  if (publishQueue) {
    const delay = new Date(post.scheduledAt).getTime() - Date.now();
    await publishQueue.add('publish-post', 
      { postId: post._id }, 
      { delay: Math.max(0, delay), jobId: post._id.toString() }
    );
  } else {
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
 * Feed sync: every 2 hours, Insight sync: every 24 hours.
 */
const startSyncFallbacks = () => {
  // Feed Sync fallback — every 2 hours
  if (feedSyncIntervalId) clearInterval(feedSyncIntervalId);
  feedSyncIntervalId = setInterval(async () => {
    try {
      await runFeedSync();
    } catch (err) {
      console.error('❌ [Fallback] Feed sync error:', err.message);
    }
  }, 2 * 60 * 60 * 1000); // 2 hours

  // Insight Sync fallback — every 24 hours
  if (insightSyncIntervalId) clearInterval(insightSyncIntervalId);
  insightSyncIntervalId = setInterval(async () => {
    try {
      await runInsightSync();
    } catch (err) {
      console.error('❌ [Fallback] Insight sync error:', err.message);
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
