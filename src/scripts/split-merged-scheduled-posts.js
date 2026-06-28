import 'dotenv/config';
import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import ScheduledPost from '../models/ScheduledPost.js';
import { connectRedis, getRedisConnection } from '../config/redis.js';

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
      return [key, value];
    })
);

const dryRun = args.get('dryRun') !== 'false';
const statuses = (args.get('statuses') || 'scheduled,manual_ready,downloaded')
  .split(',')
  .map((status) => status.trim())
  .filter(Boolean);

const idsToStrings = (items = []) => items.map((item) => String(item?._id || item));

const shouldQueuePost = (post) => (
  ['auto', 'hybrid'].includes(post.scheduleMode || 'auto') && post.status === 'scheduled'
);

const cloneMixedValue = (value) => (
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))
);

const getUniqueAccountIds = (post) => (
  [...new Set(idsToStrings(post.socialAccountIds).filter(Boolean))]
);

let publishQueue = null;
let redisConnection = null;

const initPublishQueue = () => {
  redisConnection = connectRedis();
  if (!redisConnection) return;

  publishQueue = new Queue('publishing-queue', {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: false,
    },
  });
};

const removeQueuedPost = async (postId) => {
  if (!publishQueue) return false;
  const job = await publishQueue.getJob(String(postId));
  if (!job) return false;
  await job.remove();
  return true;
};

const addQueuedPost = async (post) => {
  if (!publishQueue || !shouldQueuePost(post)) return false;
  const delay = new Date(post.scheduledAt).getTime() - Date.now();
  await publishQueue.add(
    'publish-post',
    { postId: post._id },
    { delay: Math.max(0, delay), jobId: post._id.toString() }
  );
  return true;
};

const splitPost = async (post) => {
  const accountIds = getUniqueAccountIds(post);
  if (accountIds.length <= 1) {
    if (!dryRun) {
      post.socialAccountIds = accountIds;
      await post.save();
    }
    return {
      id: String(post._id),
      status: dryRun ? 'would_normalize' : 'normalized',
      accounts: accountIds.length,
    };
  }

  if (dryRun) {
    return {
      id: String(post._id),
      status: 'would_split',
      accounts: accountIds.length,
      scheduleMode: post.scheduleMode,
      postStatus: post.status,
      scheduledAt: post.scheduledAt,
    };
  }

  const createdPosts = [];
  for (const accountId of accountIds) {
    const split = await ScheduledPost.create({
      userId: post.userId,
      campaignId: post.campaignId,
      socialAccountIds: [accountId],
      mediaIds: post.mediaIds,
      caption: post.caption,
      scheduledAt: post.scheduledAt,
      scheduleMode: post.scheduleMode,
      status: post.status,
      publishSource: post.publishSource,
      manualDownloadedAt: post.manualDownloadedAt,
      manualPostedAt: post.manualPostedAt,
      manualPostUrl: post.manualPostUrl,
      postedByUserId: post.postedByUserId,
      publishError: post.publishError,
      publishResponseId: post.publishResponseId,
      platformSpecifics: cloneMixedValue(post.platformSpecifics),
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
    });
    createdPosts.push(split);
  }

  const removedQueueJob = await removeQueuedPost(post._id);
  const queuedSplitJobs = [];
  for (const split of createdPosts) {
    if (await addQueuedPost(split)) {
      queuedSplitJobs.push(String(split._id));
    }
  }

  await ScheduledPost.deleteOne({ _id: post._id });

  return {
    id: String(post._id),
    status: 'split',
    accounts: accountIds.length,
    createdPostIds: createdPosts.map((item) => String(item._id)),
    removedQueueJob,
    queuedSplitJobs,
  };
};

const main = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  if (!dryRun) initPublishQueue();

  const posts = await ScheduledPost.find({
    status: { $in: statuses },
    'socialAccountIds.1': { $exists: true },
  }).sort({ scheduledAt: 1 });

  const results = [];
  for (const post of posts) {
    results.push(await splitPost(post));
  }

  console.log(JSON.stringify({
    dryRun,
    statuses,
    matched: posts.length,
    split: results.filter((item) => item.status === 'split').length,
    normalized: results.filter((item) => item.status === 'normalized').length,
    queuedSplitJobs: results.reduce((total, item) => total + (item.queuedSplitJobs?.length || 0), 0),
    samples: results.slice(0, 10),
  }, null, 2));

  if (publishQueue) await publishQueue.close();
  const connection = getRedisConnection() || redisConnection;
  if (connection) await connection.quit();
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message);
  if (publishQueue) await publishQueue.close().catch(() => {});
  const connection = getRedisConnection() || redisConnection;
  if (connection) await connection.quit().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
