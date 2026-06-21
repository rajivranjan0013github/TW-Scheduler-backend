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

/**
 * Fetches the latest published posts from a Facebook Page via Meta Graph API.
 * @param {Object} account - SocialAccount document
 * @returns {Promise<Array>} - Array of normalized post objects
 */
const fetchFacebookPosts = async (account) => {
  const url = `https://graph.facebook.com/v20.0/${account.accountId}/published_posts?fields=id,message,created_time,full_picture,permalink_url&limit=25&access_token=${account.accessToken}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `Facebook feed fetch failed (status ${response.status})`);
  }

  return (data.data || []).map(post => ({
    metaPostId: post.id,
    platform: 'facebook',
    content: post.message || '',
    mediaUrl: post.full_picture || '',
    videoUrl: '',
    mediaType: post.full_picture ? 'IMAGE' : '',
    permalink: post.permalink_url || `https://facebook.com/${post.id}`,
    publishedAt: new Date(post.created_time),
  }));
};

/**
 * Fetches the latest published media from an Instagram Business Account via Meta Graph API.
 * @param {Object} account - SocialAccount document
 * @returns {Promise<Array>} - Array of normalized post objects
 */
const fetchInstagramPosts = async (account) => {
  const graphHost = account.authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const url = `https://${graphHost}/v20.0/${account.accountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=25&access_token=${account.accessToken}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `Instagram media fetch failed (status ${response.status})`);
  }

  return (data.data || []).map(post => ({
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

/**
 * Syncs the latest published posts for all connected accounts into the PublishedPost cache.
 */
export const runFeedSync = async () => {
  const isConnected = getDBStatus();
  if (!isConnected) {
    return;
  }

  const startTime = Date.now();

  try {
    const accounts = await SocialAccount.find({ isConnected: true });
    let totalNewPosts = 0;
    let totalUpdatedPosts = 0;
    let accountsProcessed = 0;
    let accountsFailed = 0;

    for (const account of accounts) {
      // Skip mock accounts
      if (account.accessToken?.startsWith('mock-')) {
        continue;
      }

      try {
        let posts = [];

        if (account.platform === 'facebook') {
          posts = await fetchFacebookPosts(account);
        } else if (account.platform === 'instagram') {
          posts = await fetchInstagramPosts(account);
        } else if (account.platform === 'youtube') {
          posts = await fetchYoutubeVideos(account);
        }

        // Upsert each post into PublishedPost
        for (const postData of posts) {
          try {
            const result = await PublishedPost.findOneAndUpdate(
              { userId: account.userId, metaPostId: postData.metaPostId },
              {
                userId: account.userId,
                campaignId: account.campaignId,
                accountId: account._id,
                ...postData,
                lastSyncedAt: new Date(),
                // Only update latestLikes/Comments if values are available from Instagram media endpoint
                ...(postData.latestLikes !== undefined && { latestLikes: postData.latestLikes }),
                ...(postData.latestComments !== undefined && { latestComments: postData.latestComments }),
              },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            if (result.createdAt && result.updatedAt && result.createdAt.getTime() === result.updatedAt.getTime()) {
              totalNewPosts++;
            } else {
              totalUpdatedPosts++;
            }
          } catch (upsertErr) {
            // Duplicate key errors are fine — another sync cycle may have inserted it
            if (upsertErr.code !== 11000) {
              console.error(`❌ [Feed Sync] Failed to upsert post ${postData.metaPostId}:`, upsertErr.message);
            }
          }
        }

        accountsProcessed++;
      } catch (accountErr) {
        accountsFailed++;
        console.error(`❌ [Feed Sync] Failed to sync account "${account.name}" (${account._id}):`, accountErr.message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  } catch (error) {
    console.error('❌ [Feed Sync] Critical error:', error.message);
  }
};
