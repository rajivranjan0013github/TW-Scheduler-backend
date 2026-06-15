import { Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import { publishPostJob } from './publisherWorker.js';

let publishQueue = null;
let intervalFallbackId = null;

export const initQueue = () => {
  const connection = getRedisConnection();

  if (connection) {
    publishQueue = new Queue('publishing-queue', {
      connection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      }
    });
    console.log('📦 BullMQ Publisher Queue initialized.');
  } else {
    console.log('⏰ Starting Sandbox local interval fallback scheduler (runs every 10 seconds).');
    startIntervalFallback();
  }
};

export const addPostToQueue = async (post) => {
  if (publishQueue) {
    const delay = new Date(post.scheduledAt).getTime() - Date.now();
    await publishQueue.add('publish-post', 
      { postId: post._id }, 
      { delay: Math.max(0, delay), jobId: post._id.toString() }
    );
    console.log(`✉️ Added post ${post._id} to BullMQ queue with delay: ${Math.max(0, delay)}ms`);
  } else {
    console.log(`✉️ Sandbox scheduler will pick up post ${post._id} at ${post.scheduledAt}`);
  }
};

export const removePostFromQueue = async (postId) => {
  if (publishQueue) {
    const job = await publishQueue.getJob(postId.toString());
    if (job) {
      await job.remove();
      console.log(`🗑️ Removed post ${postId} from BullMQ queue`);
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
        p => p.status === 'scheduled' && new Date(p.scheduledAt) <= now
      );

      for (const post of postsToPublish) {
        console.log(`⚙️ [Sandbox] Starting publication for post: ${post._id}`);
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
          scheduledAt: { $lte: now }
        });

        for (const post of postsToPublish) {
          post.status = 'publishing';
          await post.save();
          console.log(`⚙️ [DB Cron] Starting publication for post: ${post._id}`);
          
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
