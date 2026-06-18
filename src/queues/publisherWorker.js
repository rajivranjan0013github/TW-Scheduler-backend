import { Worker } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import SocialAccount from '../models/SocialAccount.js';
import Media from '../models/Media.js';
import { publishToInstagram, publishToFacebook } from '../services/metaService.js';
import { runFeedSync } from './feedSyncWorker.js';
import { runInsightSync } from './insightSyncWorker.js';
import { publishToYoutube } from '../services/youtubeService.js';

// Setup BullMQ workers if Redis is connected
let worker = null;
let feedSyncWorker = null;
let insightSyncWorker = null;

export const initWorker = () => {
  const connection = getRedisConnection();

  if (connection) {
    worker = new Worker('publishing-queue', async (job) => {
      const { postId } = job.data;
      console.log(`👷 BullMQ Worker processing post: ${postId}`);
      await publishPostJob(postId);
    }, { connection });

    worker.on('completed', (job) => {
      console.log(`✅ Job ${job.id} completed successfully.`);
    });

    worker.on('failed', (job, err) => {
      console.error(`❌ Job ${job.id} failed with error: ${err.message}`);
    });

    // Feed Sync Worker — processes feed-sync jobs every 2 hours
    feedSyncWorker = new Worker('feed-sync-queue', async (job) => {
      console.log('🔄 [BullMQ] Feed sync job triggered...');
      await runFeedSync();
    }, { connection });

    feedSyncWorker.on('completed', (job) => {
      console.log(`✅ Feed sync job ${job.id} completed.`);
    });

    feedSyncWorker.on('failed', (job, err) => {
      console.error(`❌ Feed sync job ${job.id} failed: ${err.message}`);
    });

    // Insight Sync Worker — processes insight-sync jobs daily
    insightSyncWorker = new Worker('insight-sync-queue', async (job) => {
      console.log('📊 [BullMQ] Insight sync job triggered...');
      await runInsightSync();
    }, { connection });

    insightSyncWorker.on('completed', (job) => {
      console.log(`✅ Insight sync job ${job.id} completed.`);
    });

    insightSyncWorker.on('failed', (job, err) => {
      console.error(`❌ Insight sync job ${job.id} failed: ${err.message}`);
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

    const format = (post.platformSpecifics?.type || 'reels').toLowerCase();
    console.log(`📡 Publishing [${format.toUpperCase()}] post: "${post.caption.substring(0, 30)}..." to accounts:`, post.socialAccountIds);

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
      post.status = 'published';
      post.updatedAt = new Date();
      console.log(`✨ [Sandbox] [${format.toUpperCase()}] Post ${postId} successfully published to Meta!`);
    } else {
      // Call actual Meta API for each connected account
      for (const account of accounts) {
        let publishedId = null;
        const mainMedia = mediaFiles[0]; // Grab first attached media file if any

        if (account.platform === 'instagram') {
          if (!mainMedia) {
            throw new Error('Instagram requires an attached image or video file to publish.');
          }
          publishedId = await publishToInstagram(
            account.accessToken,
            account.accountId,
            mainMedia.url,
            mainMedia.type,
            post.caption,
            account.authProvider
          );
        } else if (account.platform === 'facebook') {
          publishedId = await publishToFacebook(
            account.accessToken,
            account.accountId,
            mainMedia?.url,
            mainMedia?.type,
            post.caption
          );
        } else if (account.platform === 'youtube') {
          publishedId = await publishToYoutube({
            account,
            media: mainMedia,
            caption: post.caption,
            specifics: post.platformSpecifics,
          });
        } else {
          throw new Error(`Unsupported social platform: ${account.platform}`);
        }

        publishResponses.push({
          accountId: account._id,
          platform: account.platform,
          publishId: publishedId,
        });
      }

      post.status = 'published';
      post.publishResponseId = JSON.stringify(publishResponses);
      await post.save();
      console.log(`✨ [DB] [${format.toUpperCase()}] Post ${postId} successfully published to Meta! Responses:`, publishResponses);
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
