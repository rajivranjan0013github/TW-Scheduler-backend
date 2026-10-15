import { Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { getDBStatus } from '../config/db.js';
import { processComment } from '../services/commentAutomationService.js';
import { pollYoutubeComments } from '../services/youtubeCommentPoller.js';
import { isBackgroundSyncEnabled } from './publisherQueue.js';

let automationQueue = null;
let automationWorker = null;
let youtubePollQueue = null;
let youtubePollWorker = null;
let youtubePollIntervalId = null;

const YOUTUBE_POLL_MINUTES = Math.max(2, Number(process.env.YOUTUBE_COMMENT_POLL_MINUTES) || 5);

const runYoutubePoll = () => pollYoutubeComments((comment) => enqueueComment(comment));

const startYoutubeCommentPolling = async (connection) => {
  if (!isBackgroundSyncEnabled()) {
    console.info('[Automation] YouTube comment polling disabled (ENABLE_BACKGROUND_SYNC is false).');
    return;
  }
  if (!connection) {
    if (youtubePollIntervalId) clearInterval(youtubePollIntervalId);
    youtubePollIntervalId = setInterval(() => {
      if (!getDBStatus()) return;
      runYoutubePoll().catch((error) => console.error('[Automation] YouTube poll failed:', error.message));
    }, YOUTUBE_POLL_MINUTES * 60 * 1000);
    return;
  }

  youtubePollQueue = new Queue('youtube-comment-poll-queue', {
    connection,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  });
  await youtubePollQueue.add('youtube-comment-poll', {}, {
    repeat: { every: YOUTUBE_POLL_MINUTES * 60 * 1000 },
    jobId: 'youtube-comment-poll-repeatable',
  });
  youtubePollWorker = new Worker('youtube-comment-poll-queue', runYoutubePoll, { connection, concurrency: 1 });
  youtubePollWorker.on('failed', (job, err) => {
    console.error(`[Automation] YouTube poll job ${job?.id} failed: ${err.message}`);
  });
};

// Small random delay so automated replies don't land in an instant, bot-like burst
const getHumanizedDelayMs = () => 3000 + Math.floor(Math.random() * 7000);

export const initAutomationQueue = async () => {
  const connection = getRedisConnection();
  try {
    await startYoutubeCommentPolling(connection);
  } catch (error) {
    console.error('[Automation] Could not start YouTube comment polling:', error.message);
  }
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
    processComment(job.data.comment)
  ), {
    connection,
    concurrency: Math.max(1, Number(process.env.AUTOMATION_CONCURRENCY) || 3),
    // Stay well under Meta's messaging limits across all accounts
    limiter: { max: 20, duration: 1000 },
  });

  automationWorker.on('failed', (job, err) => {
    console.error(`[Automation] Job ${job?.id} failed: ${err.message}`);
  });
};

export const enqueueComment = async (comment) => {
  if (automationQueue) {
    // jobId dedupes Meta's webhook retries before they ever reach the worker
    await automationQueue.add('comment', { comment }, {
      jobId: `${comment.platform || 'instagram'}-comment-${comment.commentId}`,
      delay: getHumanizedDelayMs(),
    });
    return;
  }

  if (!getDBStatus()) return;
  setTimeout(() => {
    processComment(comment).catch((error) => {
      console.error(`[Automation] Comment ${comment.commentId} failed:`, error.message);
    });
  }, getHumanizedDelayMs());
};
