import { Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { getDBStatus } from '../config/db.js';
import { processInstagramComment } from '../services/instagramAutomationService.js';

let automationQueue = null;
let automationWorker = null;

// Small random delay so automated replies don't land in an instant, bot-like burst
const getHumanizedDelayMs = () => 3000 + Math.floor(Math.random() * 7000);

export const initAutomationQueue = () => {
  const connection = getRedisConnection();
  if (!connection) return;

  automationQueue = new Queue('comment-automation-queue', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });

  automationWorker = new Worker('comment-automation-queue', async (job) => (
    processInstagramComment(job.data.comment)
  ), {
    connection,
    concurrency: Math.max(1, Number(process.env.AUTOMATION_CONCURRENCY) || 3),
    // Stay well under Instagram's messaging limits across all accounts
    limiter: { max: 20, duration: 1000 },
  });

  automationWorker.on('failed', (job, err) => {
    console.error(`[Automation] Job ${job?.id} failed: ${err.message}`);
  });
};

export const enqueueInstagramComment = async (comment) => {
  if (automationQueue) {
    // jobId dedupes Meta's webhook retries before they ever reach the worker
    await automationQueue.add('instagram-comment', { comment }, {
      jobId: `ig-comment-${comment.commentId}`,
      delay: getHumanizedDelayMs(),
    });
    return;
  }

  if (!getDBStatus()) return;
  setTimeout(() => {
    processInstagramComment(comment).catch((error) => {
      console.error(`[Automation] Comment ${comment.commentId} failed:`, error.message);
    });
  }, getHumanizedDelayMs());
};
