/**
 * Feed Sync Worker
 * 
 * Runs every 2 hours. Fetches the latest published posts from Meta for all
 * connected social accounts and upserts them into the PublishedPost collection.
 * 
 * This ensures the "View Feed" modal loads instantly from cached data.
 */

import SocialAccount from '../models/SocialAccount.js';
import PublishedPost from '../models/PublishedPost.js';
import { getDBStatus } from '../config/db.js';
import { fetchYoutubeVideos } from '../services/youtubeService.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from '../services/tokenHealthService.js';
import { fetchFacebookPostEngagement, fetchFacebookPostViews } from '../services/facebookMetricsService.js';
import {
  acquireAccountSyncLease,
  releaseAccountSyncLease,
  withProviderSyncSlot,
} from '../services/syncLeaseService.js';

const MAX_FEED_SYNC_PAGES = 20;
const FACEBOOK_POST_CONCURRENCY = 3;

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

export const fetchMetaPagedData = async (initialUrl, { maxPages = MAX_FEED_SYNC_PAGES, shouldStop = null } = {}) => {
  const items = [];
  let url = initialUrl;
  let page = 0;

  while (url && page < maxPages) {
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Meta feed fetch failed (status ${response.status})`);
    }

    const pageItems = data.data || [];
    items.push(...pageItems);
    if (typeof shouldStop === 'function' && shouldStop(pageItems)) break;
    url = data.paging?.next || '';
    page += 1;
  }

  return items;
};

/**
 * Fetches the latest published posts from a Facebook Page via Meta Graph API.
 * @param {Object} account - SocialAccount document
 * @returns {Promise<Array>} - Array of normalized post objects
 */
export const fetchFacebookPosts = async (account, { maxPages = MAX_FEED_SYNC_PAGES, limit = 100, sinceDate = null } = {}) => {
  const url = `https://graph.facebook.com/v20.0/${account.accountId}/published_posts?fields=id,message,created_time,full_picture,permalink_url,object_id&limit=${limit}&access_token=${account.accessToken}`;
  const cutoff = sinceDate ? new Date(sinceDate).getTime() : null;
  const data = (await fetchMetaPagedData(url, {
    maxPages,
    shouldStop: cutoff ? (items) => items.some((post) => new Date(post.created_time).getTime() < cutoff) : null,
  })).filter((post) => !cutoff || new Date(post.created_time).getTime() >= cutoff);

  return mapWithConcurrency(data, FACEBOOK_POST_CONCURRENCY, async (post) => {
    const [viewResult, engagement] = await Promise.all([
      fetchFacebookPostViews(account.accessToken, post),
      fetchFacebookPostEngagement(account.accessToken, post.id),
    ]);
    const facebookVideoId = viewResult.videoId || '';

    return {
      metaPostId: post.id,
      platform: 'facebook',
      content: post.message || '',
      mediaUrl: post.full_picture || '',
      videoUrl: '',
      mediaType: facebookVideoId ? 'VIDEO' : (post.full_picture ? 'IMAGE' : ''),
      facebookVideoId,
      viewsSource: viewResult.source,
      permalink: post.permalink_url || `https://facebook.com/${post.id}`,
      publishedAt: new Date(post.created_time),
      ...(viewResult.views !== null && { latestViews: viewResult.views }),
      ...(engagement.likes !== null && { latestLikes: engagement.likes }),
      ...(engagement.comments !== null && { latestComments: engagement.comments }),
    };
  });
};

/**
 * Fetches the latest published media from an Instagram Business Account via Meta Graph API.
 * @param {Object} account - SocialAccount document
 * @returns {Promise<Array>} - Array of normalized post objects
 */
export const fetchInstagramPosts = async (account, { maxPages = MAX_FEED_SYNC_PAGES, limit = 100, sinceDate = null } = {}) => {
  const graphHost = account.authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const url = `https://${graphHost}/v20.0/${account.accountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=${limit}&access_token=${account.accessToken}`;
  const cutoff = sinceDate ? new Date(sinceDate).getTime() : null;
  const data = (await fetchMetaPagedData(url, {
    maxPages,
    shouldStop: cutoff ? (items) => items.some((post) => new Date(post.timestamp).getTime() < cutoff) : null,
  })).filter((post) => !cutoff || new Date(post.timestamp).getTime() >= cutoff);

  return data.map(post => ({
    metaPostId: post.id,
    platform: 'instagram',
    content: post.caption || '',
    mediaUrl: post.thumbnail_url || post.media_url || '',
    videoUrl: post.media_type === 'VIDEO' ? post.media_url : '',
    mediaType: post.media_type || '',
    permalink: post.permalink || `https://instagram.com/p/${post.id}`,
    publishedAt: new Date(post.timestamp),
    // Store initial metrics from the media endpoint itself
    latestLikes: post.like_count || 0,
    latestComments: post.comments_count || 0,
  }));
};

export const runAccountFeedSync = async (accountOrId, { windowDays = 14, acquireLease = true } = {}) => {
  const account = typeof accountOrId === 'object' && accountOrId?._id
    ? accountOrId
    : await SocialAccount.findById(accountOrId);
  if (!account) throw new Error('Account not found.');
  if (!account.isConnected) throw new Error('Account requires reconnection.');
  if (account.accessToken?.startsWith('mock-')) throw new Error('Mock account feed access is disabled.');

  const leaseOwner = acquireLease ? await acquireAccountSyncLease(account._id) : '';
  if (acquireLease && !leaseOwner) return { skipped: true, reason: 'already_running', postsDiscovered: 0 };

  try {
    const freshAccount = await ensureFreshAccountToken(account);
    const cutoff = Date.now() - Math.max(1, Number(windowDays) || 14) * 24 * 60 * 60 * 1000;
    const sinceDate = new Date(cutoff);
    let posts = await withProviderSyncSlot(freshAccount.platform, async () => {
      if (freshAccount.platform === 'facebook') return fetchFacebookPosts(freshAccount, { sinceDate });
      if (freshAccount.platform === 'instagram') return fetchInstagramPosts(freshAccount, { sinceDate });
      if (freshAccount.platform === 'youtube') return fetchYoutubeVideos(freshAccount, { limit: 50 });
      return [];
    });

    posts = posts.filter((post) => new Date(post.publishedAt || post.createdAt).getTime() >= cutoff);
    const syncTime = new Date();
    if (posts.length > 0) {
      await PublishedPost.bulkWrite(posts.map((postData) => ({
      updateOne: {
        filter: { userId: freshAccount.userId, metaPostId: postData.metaPostId || postData.id },
        update: { $set: {
          userId: freshAccount.userId,
          campaignId: freshAccount.campaignId,
          accountId: freshAccount._id,
          metaPostId: postData.metaPostId || postData.id,
          platform: freshAccount.platform,
          content: postData.content || '',
          mediaUrl: postData.mediaUrl || '',
          videoUrl: postData.videoUrl || '',
          mediaType: postData.mediaType || '',
          facebookVideoId: postData.facebookVideoId || '',
          viewsSource: postData.viewsSource || '',
          permalink: postData.permalink || '',
          publishedAt: new Date(postData.publishedAt || postData.createdAt),
          lastSyncedAt: syncTime,
          ...(postData.latestViews !== undefined || postData.views !== undefined
            ? { latestViews: Number(postData.latestViews ?? postData.views) || 0 } : {}),
          ...(postData.latestLikes !== undefined || postData.likes !== undefined
            ? { latestLikes: Number(postData.latestLikes ?? postData.likes) || 0 } : {}),
          ...(postData.latestComments !== undefined || postData.comments !== undefined
            ? { latestComments: Number(postData.latestComments ?? postData.comments) || 0 } : {}),
        } },
        upsert: true,
      },
      })), { ordered: false });
    }
    return { postsDiscovered: posts.length, syncTime };
  } finally {
    if (acquireLease) await releaseAccountSyncLease(account._id, leaseOwner);
  }
};

/**
 * Syncs the latest published posts for all connected accounts into the PublishedPost cache.
 */
export const runFeedSync = async () => {
  const isConnected = getDBStatus();
  if (!isConnected) {
    return;
  }

  try {
    const accounts = await SocialAccount.find({ isConnected: true });
    let accountsProcessed = 0;
    let accountsFailed = 0;

    for (const account of accounts) {
      // Skip mock accounts
      if (account.accessToken?.startsWith('mock-')) {
        continue;
      }

      try {
        const result = await runAccountFeedSync(account, { windowDays: 30 });
        if (!result.skipped) accountsProcessed++;
      } catch (accountErr) {
        accountsFailed++;
        await handleProviderAuthFailure(account, accountErr, accountErr.message);
        console.error(`❌ [Feed Sync] Failed to sync account "${account.name}" (${account._id}):`, accountErr.message);
      }
    }

    return { accountsProcessed, accountsFailed };
  } catch (error) {
    console.error('❌ [Feed Sync] Critical error:', error.message);
  }
};
