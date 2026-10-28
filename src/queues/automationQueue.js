import { Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { getDBStatus } from '../config/db.js';
import { processComment, processStoredComment } from '../services/commentAutomationService.js';
import { pollYoutubeComments } from '../services/youtubeCommentPoller.js';
import { isBackgroundSyncEnabled } from './publisherQueue.js';
import SocialAccount from '../models/SocialAccount.js';
import SocialComment from '../models/SocialComment.js';
import { findAccountsForEntry, getOwnIds } from '../services/socialProviders/index.js';
import { removeAutomationJobsForAccounts } from '../services/automationJobPrivacy.js';

const localJobs = new Set();

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
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  // Remove retained payloads left by previous versions before accepting new work.
  for (const job of await automationQueue.getJobs(['completed', 'failed'])) {
    if (job) await job.remove();
  }

  automationWorker = new Worker('comment-automation-queue', async (job) => {
    if (!job.data.comment) return processStoredComment(job.data);
    // Allow already queued legacy work to finish, then erase its raw payload.
    try {
      return await processComment(job.data.comment);
    } finally {
      await job.updateData({});
    }
  }, {
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
  if (!getDBStatus()) return;
  if (comment.parentId) return;
  const accounts = await findAccountsForEntry(comment.platform || 'instagram', comment.entryId);
  for (const account of accounts) {
    if (getOwnIds(account).includes(comment.fromId)) continue;
    const stored = await SocialComment.findOne({ socialAccountId: account._id, commentId: comment.commentId }).select('_id');
    if (!stored || !await SocialAccount.exists({ _id: account._id, isConnected: true })) continue;
    const data = { socialAccountId: String(account._id), socialCommentId: String(stored._id) };
    if (automationQueue) {
      await automationQueue.add('comment', data, {
        jobId: `comment-${stored._id}`,
        delay: getHumanizedDelayMs(),
      });
      // Cover a disconnect that raced with insertion into Redis.
      if (!await SocialAccount.exists({ _id: account._id, isConnected: true })) {
        await removeAutomationJobsForAccounts(automationQueue, [account]);
      }
      continue;
    }
    const localJob = { data, timer: null, running: null };
    localJobs.add(localJob);
    localJob.timer = setTimeout(() => {
      localJob.timer = null;
      localJob.running = processStoredComment(data)
        .catch((error) => console.error('[Automation] Comment processing failed:', error.message))
        .finally(() => localJobs.delete(localJob));
    }, getHumanizedDelayMs());
  }
};

export const purgeQueuedAutomations = async (accounts) => {
  const accountIds = new Set(accounts.map((account) => String(account._id)));
  const running = [];
  for (const job of localJobs) {
    if (!accountIds.has(job.data.socialAccountId)) continue;
    if (job.timer) {
      clearTimeout(job.timer);
      localJobs.delete(job);
    }
    if (job.running) running.push(job.running);
  }
  await Promise.all(running);
  await removeAutomationJobsForAccounts(automationQueue, accounts);
};
