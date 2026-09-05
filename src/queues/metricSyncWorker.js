import SocialAccount from '../models/SocialAccount.js';
import PublishedPost from '../models/PublishedPost.js';
import PostInsight from '../models/PostInsight.js';
import PostMetricSnapshot from '../models/PostMetricSnapshot.js';
import PostMetricDailySnapshot from '../models/PostMetricDailySnapshot.js';
import MetricSyncStatus from '../models/MetricSyncStatus.js';
import { getDBStatus } from '../config/db.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from '../services/tokenHealthService.js';
import { fetchInstagramMediaMetrics } from '../services/instagramMetricsService.js';
import {
  fetchFacebookPostEngagement,
  fetchFacebookPostViews,
} from '../services/facebookMetricsService.js';
import { fetchYoutubeVideoMetrics } from '../services/youtubeService.js';
import { runAccountFeedSync } from './feedSyncWorker.js';
import {
  acquireAccountSyncLease,
  acquireSyncLease,
  releaseAccountSyncLease,
  releaseSyncLease,
  withProviderSyncSlot,
} from '../services/syncLeaseService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LATEST_POST_LIMIT = 14;
const ACCOUNT_CONCURRENCY = 3;
const FACEBOOK_POST_CONCURRENCY = 3;
const leaseDurations = { hot: 25 * 60 * 1000, warm: 110 * 60 * 1000, daily: 6 * HOUR_MS };
const logSyncEvent = (level, event, details = {}) => {
  const logger = console[level] || console.info;
  logger(`[Metric Sync] ${event}`, {
    timestamp: new Date().toISOString(),
    ...details,
  });
};

const toKey = (value) => value?._id?.toString?.() || value?.toString?.() || '';
const dateKey = (date) => new Date(date).toISOString().slice(0, 10);
const startOfHour = (date) => {
  const bucket = new Date(date);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80004]);

export const isProviderRateLimit = (error) => {
  const status = Number(error?.status || 0);
  const code = Number(error?.error?.code || error?.code || 0);
  return status === 429 || META_RATE_LIMIT_CODES.has(code);
};

const isRetryableProviderError = (error) => {
  const status = Number(error?.status || 0);
  const code = Number(error?.error?.code || error?.code || 0);
  return error?.retryable === true
    || status === 429
    || META_RATE_LIMIT_CODES.has(code)
    || status >= 500
    || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code);
};

export const healStaleSyncStatuses = async (cutoffMinutes = 10) => {
  const cutoff = new Date(Date.now() - cutoffMinutes * 60 * 1000);
  return MetricSyncStatus.updateMany(
    {
      status: { $in: ['running', 'queued'] },
      lastAttemptAt: { $lt: cutoff },
    },
    {
      $set: {
        status: 'failed',
        lastError: 'Synchronization session timed out.',
      },
    }
  );
};

const withProviderRetry = async (task, attempts = 4) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error) || attempt === attempts - 1) throw error;
      const isRateLimited = isProviderRateLimit(error);
      const retryAfterMs = Number(error?.retryAfterMs || 0);
      const backoffMs = retryAfterMs || (isRateLimited ? (15000 * (2 ** attempt)) : (5000 * (2 ** attempt))) + Math.floor(Math.random() * 1000);
      logSyncEvent('warn', 'provider_retry_scheduled', {
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        waitMs: backoffMs,
        isRateLimited,
        status: Number(error?.status || error?.error?.code || 0) || undefined,
        error: String(error?.message || error).slice(0, 300),
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
};

const acquireLease = async (tier) => {
  const durationMs = leaseDurations[tier] || 15 * 60 * 1000;
  return acquireSyncLease(`metric-sync:${tier}`, durationMs);
};

const releaseLease = async (tier, owner) => {
  if (owner) await releaseSyncLease(`metric-sync:${tier}`, owner);
};

const fetchInstagramMetrics = async (account, posts) => {
  const rows = await mapWithConcurrency(posts, FACEBOOK_POST_CONCURRENCY, async (post) => {
    const result = await fetchInstagramMediaMetrics(account, post.metaPostId);
    return [post, result];
  });
  const failedMetrics = rows.flatMap(([, result]) => result.errors);
  if (failedMetrics.length > 0) {
    const firstError = failedMetrics[0];
    logSyncEvent('warn', 'instagram_metrics_partially_unavailable', {
      accountId: String(account._id),
      failedRequests: failedMetrics.length,
      code: firstError.code,
      statusCode: firstError.status,
      error: firstError.message,
    });
  }
  return new Map(rows.flatMap(([post, result]) => (
    result.hasFreshMetrics
      ? [[toKey(post._id), {
        views: result.views,
        likes: result.likes,
        comments: result.comments,
        viewsSource: result.viewsSource,
      }]]
      : []
  )));
};

export const resolveFacebookAnalyticsStatus = (rows = []) => {
  const hasSuccessfulEngagement = rows.some(([, metrics]) => !metrics.engagementErrorType);
  const permissionMissing = rows.some(([, metrics]) => metrics.engagementErrorType === 'permission_missing');

  // A single stale or inaccessible Facebook post can return error code 10 even
  // when the Page token can read engagement for the account's other posts.
  // Only treat this as an account-wide permission problem when no post succeeds.
  if (hasSuccessfulEngagement) {
    return { status: 'healthy', error: '' };
  }
  if (permissionMissing) {
    return {
      status: 'permission_missing',
      error: 'Facebook denied Page engagement access. Reconnect and grant pages_read_engagement.',
    };
  }
  return {
    status: 'unavailable',
    error: 'Facebook analytics are temporarily unavailable.',
  };
};

const fetchFacebookMetrics = async (account, posts) => {
  const rows = await mapWithConcurrency(posts, FACEBOOK_POST_CONCURRENCY, async (post) => {
    const [viewResult, engagement] = await Promise.all([
      fetchFacebookPostViews(account.accessToken, post),
      fetchFacebookPostEngagement(account.accessToken, post.metaPostId),
    ]);
    return [toKey(post._id), {
      views: viewResult.source === 'unavailable' ? null : Number(viewResult.views) || 0,
      likes: engagement.likes,
      comments: engagement.comments,
      engagementErrorType: engagement.errorType,
      viewsSource: viewResult.source,
      facebookVideoId: viewResult.videoId || post.facebookVideoId || '',
    }];
  });

  const analyticsHealth = resolveFacebookAnalyticsStatus(rows);
  await SocialAccount.updateOne(
    { _id: account._id },
    { $set: {
      analyticsStatus: analyticsHealth.status,
      analyticsError: analyticsHealth.error,
      analyticsLastCheckedAt: new Date(),
    } }
  );
  return new Map(rows);
};

const fetchAccountMetrics = async (account, posts) => withProviderSyncSlot(account.platform, () => withProviderRetry(async () => {
  if (account.platform === 'youtube') {
    const byVideoId = await fetchYoutubeVideoMetrics(account, posts.map((post) => post.metaPostId));
    return new Map(posts.flatMap((post) => {
      const metrics = byVideoId.get(String(post.metaPostId));
      return metrics ? [[toKey(post._id), metrics]] : [];
    }));
  }

  const freshAccount = await ensureFreshAccountToken(account);
  if (freshAccount.platform === 'instagram') return fetchInstagramMetrics(freshAccount, posts);
  if (freshAccount.platform === 'facebook') return fetchFacebookMetrics(freshAccount, posts);
  return new Map();
}));

const persistMetrics = async (account, posts, metricMap, syncTime) => {
  const successfulPosts = posts.filter((post) => metricMap.has(toKey(post._id)));
  if (successfulPosts.length === 0) return 0;

  const hourBucket = startOfHour(syncTime);
  const previousSnapshots = await PostMetricSnapshot.find({
    postId: { $in: successfulPosts.map((post) => post._id) },
    capturedAt: { $lt: hourBucket },
  }).sort({ capturedAt: -1 }).lean();
  const previousByPost = new Map();
  previousSnapshots.forEach((snapshot) => {
    const key = toKey(snapshot.postId);
    if (!previousByPost.has(key)) previousByPost.set(key, snapshot);
  });

  const hourlyExpiry = new Date(syncTime.getTime() + 30 * DAY_MS);
  const dailyExpiry = new Date(syncTime.getTime() + 730 * DAY_MS);
  const today = dateKey(syncTime);
  const postWrites = [];
  const hourlyWrites = [];
  const dailyWrites = [];
  const compatibilityWrites = [];

  successfulPosts.forEach((post) => {
    const key = toKey(post._id);
    const fresh = metricMap.get(key);
    const current = {
      views: fresh.views ?? Number(post.latestViews || 0),
      likes: fresh.likes ?? Number(post.latestLikes || 0),
      comments: fresh.comments ?? Number(post.latestComments || 0),
    };
    const previous = previousByPost.get(key);
    const source = fresh.viewsSource || post.viewsSource || '';
    const campaignId = post.campaignId || account.campaignId || null;

    const isYouTube = post.platform === 'youtube' || account.platform === 'youtube';
    // YouTube Developer Policy Section III.E.4: Do not store numeric metrics for >30 calendar days
    const postDailyExpiry = isYouTube
      ? new Date(syncTime.getTime() + 30 * DAY_MS)
      : dailyExpiry;
    const postHourlyExpiry = isYouTube
      ? new Date(syncTime.getTime() + 30 * DAY_MS)
      : hourlyExpiry;

    postWrites.push({
      updateOne: {
        filter: { _id: post._id },
        update: { $set: {
          latestViews: current.views,
          latestLikes: current.likes,
          latestComments: current.comments,
          lastSyncedAt: syncTime,
          viewsSource: source,
          ...(fresh.facebookVideoId ? { facebookVideoId: fresh.facebookVideoId } : {}),
        } },
      },
    });
    hourlyWrites.push({
      updateOne: {
        filter: { postId: post._id, capturedAt: hourBucket },
        update: { $set: {
          campaignId,
          accountId: account._id,
          views: current.views,
          likes: current.likes,
          comments: current.comments,
          viewDelta: previous ? Math.max(0, current.views - Number(previous.views || 0)) : 0,
          likeDelta: previous ? Math.max(0, current.likes - Number(previous.likes || 0)) : 0,
          commentDelta: previous ? Math.max(0, current.comments - Number(previous.comments || 0)) : 0,
          viewsSource: source,
          expiresAt: postHourlyExpiry,
        } },
        upsert: true,
      },
    });
    dailyWrites.push({
      updateOne: {
        filter: { postId: post._id, dateStr: today },
        update: { $set: { campaignId, accountId: account._id, ...current, viewsSource: source, expiresAt: postDailyExpiry } },
        upsert: true,
      },
    });
    compatibilityWrites.push({
      updateOne: {
        filter: { postId: post._id, dateStr: today },
        update: { $set: { campaignId, accountId: account._id, ...current } },
        upsert: true,
      },
    });
  });

  await Promise.all([
    PublishedPost.bulkWrite(postWrites),
    PostMetricSnapshot.bulkWrite(hourlyWrites),
    PostMetricDailySnapshot.bulkWrite(dailyWrites),
    PostInsight.bulkWrite(compatibilityWrites),
  ]);
  return successfulPosts.length;
};

export const recordStoredMetricSnapshots = async (accountId, metaPostIds = [], syncTime = new Date()) => {
  const uniqueIds = [...new Set(metaPostIds.map(String).filter(Boolean))];
  if (uniqueIds.length === 0) return 0;
  const [account, posts] = await Promise.all([
    SocialAccount.findById(accountId),
    PublishedPost.find({ accountId, metaPostId: { $in: uniqueIds } }).lean(),
  ]);
  if (!account || posts.length === 0) return 0;
  const metricMap = new Map(posts.map((post) => [toKey(post._id), {
    views: Number(post.latestViews || 0),
    likes: Number(post.latestLikes || 0),
    comments: Number(post.latestComments || 0),
    viewsSource: post.viewsSource || '',
    facebookVideoId: post.facebookVideoId || '',
  }]));
  return persistMetrics(account, posts, metricMap, syncTime);
};

const selectTierPosts = async (accountId, tier, now) => {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);
  const posts = await PublishedPost.find({ accountId, publishedAt: { $gte: thirtyDaysAgo } })
    .sort({ publishedAt: -1 })
    .lean();
  const latest = posts.slice(0, LATEST_POST_LIMIT);
  const hotCutoff = new Date(now.getTime() - 48 * HOUR_MS);

  if (tier === 'manual') return latest;
  if (tier === 'hot') return latest.filter((post) => new Date(post.publishedAt) >= hotCutoff);
  if (tier === 'warm') return latest.filter((post) => new Date(post.publishedAt) < hotCutoff);
  return posts;
};

const updateStatus = (accountId, tier, values) => MetricSyncStatus.findOneAndUpdate(
  { accountId, tier },
  { $set: values },
  { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
);

export const runAccountMetricSync = async (accountOrId, tier = 'manual', syncTime = new Date(), { acquireAccountLease = true } = {}) => {
  const account = typeof accountOrId === 'object' && accountOrId?._id
    ? accountOrId
    : await SocialAccount.findById(accountOrId);
  if (!account) throw new Error('Account not found.');

  const owner = acquireAccountLease ? await acquireAccountSyncLease(account._id) : '';
  if (acquireAccountLease && !owner) {
    logSyncEvent('warn', 'account_sync_skipped', {
      accountId: String(account._id),
      platform: account.platform,
      tier,
      reason: 'already_running',
    });
    return { skipped: true, reason: 'already_running' };
  }
  logSyncEvent('info', 'account_sync_started', {
    accountId: String(account._id),
    platform: account.platform,
    tier,
  });
  await updateStatus(account._id, tier, { status: 'running', lastAttemptAt: syncTime, lastError: '' });
  try {
    const posts = await selectTierPosts(account._id, tier, syncTime);
    if (posts.length === 0) {
      await updateStatus(account._id, tier, { status: 'success', lastSuccessAt: syncTime, postsProcessed: 0, lastError: '' });
      logSyncEvent('info', 'account_sync_skipped', {
        accountId: String(account._id), platform: account.platform, tier, reason: `no_${tier}_posts`,
      });
      return { skipped: true, reason: `no_${tier}_posts`, postsProcessed: 0, postsRequested: 0 };
    }

    let metricMap = await fetchAccountMetrics(account, posts);
    const missingPosts = posts.filter((post) => !metricMap.has(toKey(post._id)));
    if (missingPosts.length > 0) {
      const retryMap = await fetchAccountMetrics(account, missingPosts);
      metricMap = new Map([...metricMap, ...retryMap]);
    }
    const processed = await persistMetrics(account, posts, metricMap, syncTime);
    const status = processed === posts.length ? 'success' : processed > 0 ? 'partial' : 'failed';
    const lastError = status === 'success' ? '' : `Provider returned metrics for ${processed} of ${posts.length} posts.`;
    await updateStatus(account._id, tier, {
      status,
      ...(processed > 0 ? { lastSuccessAt: syncTime } : {}),
      postsProcessed: processed,
      lastError,
    });
    logSyncEvent(status === 'success' ? 'info' : 'warn', `account_sync_${status}`, {
      accountId: String(account._id),
      platform: account.platform,
      tier,
      postsProcessed: processed,
      postsRequested: posts.length,
      ...(lastError ? { error: lastError } : {}),
    });
    return { status, postsProcessed: processed, postsRequested: posts.length, lastError };
  } catch (error) {
    await handleProviderAuthFailure(account, error, error.message);
    const isRateLimited = isProviderRateLimit(error);
    const status = isRateLimited ? 'rate_limited' : 'failed';
    const errorMessage = isRateLimited
      ? 'Provider rate limit reached. Synchronization will resume on the next interval.'
      : String(error.message || error).slice(0, 500);
    await updateStatus(account._id, tier, { status, postsProcessed: 0, lastError: errorMessage });
    logSyncEvent('error', `account_sync_${status}`, {
      accountId: String(account._id),
      platform: account.platform,
      tier,
      isRateLimited,
      statusCode: Number(error?.status || error?.error?.code || 0) || undefined,
      error: errorMessage,
    });
    throw error;
  } finally {
    if (acquireAccountLease) await releaseAccountSyncLease(account._id, owner);
  }
};

export const runManualAccountSync = async (accountId) => {
  const owner = await acquireAccountSyncLease(accountId);
  if (!owner) {
    logSyncEvent('warn', 'manual_sync_waiting_for_lease', { accountId: String(accountId) });
    const error = new Error('Another synchronization is already running for this account.');
    error.code = 'ACCOUNT_SYNC_BUSY';
    error.retryable = true;
    throw error;
  }
  try {
    const discovery = await runAccountFeedSync(accountId, { windowDays: 30, acquireLease: false });
    logSyncEvent('info', 'manual_feed_discovery_completed', {
      accountId: String(accountId),
      postsDiscovered: discovery.postsDiscovered,
      windowDays: 30,
    });
    return await runAccountMetricSync(accountId, 'manual', new Date(), { acquireAccountLease: false });
  } finally {
    await releaseAccountSyncLease(accountId, owner);
  }
};

export const runMetricSync = async (tier = 'warm') => {
  if (!['hot', 'warm', 'daily'].includes(tier)) throw new Error(`Unknown metric sync tier: ${tier}`);
  if (!getDBStatus()) return { skipped: true, reason: 'database_disconnected' };

  const owner = await acquireLease(tier);
  if (!owner) return { skipped: true, reason: 'already_running' };

  const now = new Date();
  const summary = { tier, accountsProcessed: 0, accountsFailed: 0, postsProcessed: 0 };
  try {
    const accounts = await SocialAccount.find({
      isConnected: true,
      accessToken: { $exists: true, $not: /^mock-/ },
    });
    await mapWithConcurrency(accounts, ACCOUNT_CONCURRENCY, async (account) => {
      try {
        const result = await runAccountMetricSync(account, tier, now);
        if (result.skipped) return;
        if (result.status === 'success') summary.accountsProcessed += 1;
        else summary.accountsFailed += 1;
        summary.postsProcessed += result.postsProcessed || 0;
      } catch (error) {
        summary.accountsFailed += 1;
        console.error(`[Metric Sync:${tier}] ${account.name || account._id} failed:`, error.message);
      }
    });
    return summary;
  } finally {
    await releaseLease(tier, owner);
  }
};
