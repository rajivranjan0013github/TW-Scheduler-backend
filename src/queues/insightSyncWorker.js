/**
 * Insight Sync Worker
 * 
 * Runs once per day at 2:00 AM IST. Fetches per-post lifetime metrics
 * from Meta Graph API using the Batch API (50 requests per HTTP call)
 * and snapshots them into the PostInsight collection for daily tracking.
 */

import SocialAccount from '../models/SocialAccount.js';
import PublishedPost from '../models/PublishedPost.js';
import PostInsight from '../models/PostInsight.js';
import { sendBatchRequests } from '../services/metaBatchService.js';
import { getDBStatus } from '../config/db.js';

/**
 * Extracts metric values from a Meta insights API response body.
 * 
 * @param {Object} responseBody - Parsed JSON body from Meta insights endpoint
 * @param {string} platform - 'instagram' or 'facebook'
 * @returns {{ views: number, likes: number, comments: number }}
 */
const extractMetrics = (responseBody, platform) => {
  const metrics = { views: 0, likes: 0, comments: 0 };

  if (!responseBody || !responseBody.data) {
    return metrics;
  }

  for (const entry of responseBody.data) {
    const name = entry.name;
    // Get the first value (lifetime total)
    const value = entry.values?.[0]?.value ?? entry.total_value?.value ?? 0;

    if (platform === 'instagram') {
      if (name === 'views') metrics.views = Number(value) || 0;
      else if (name === 'likes') metrics.likes = Number(value) || 0;
      else if (name === 'comments') metrics.comments = Number(value) || 0;
    } else if (platform === 'facebook') {
      if (name === 'post_impressions_unique') metrics.views = Number(value) || 0;
      else if (name === 'post_reactions_like_total') metrics.likes = Number(value) || 0;
    }
  }

  return metrics;
};

/**
 * Runs the daily insight sync job.
 * 
 * 1. Queries all PublishedPosts published in the last 30 days
 * 2. Groups them by account
 * 3. Sends batch requests to Meta for post-level insights
 * 4. Upserts PostInsight rows for today's date
 * 5. Updates PublishedPost lifetime metric fields
 */
export const runInsightSync = async () => {
  const isConnected = getDBStatus();
  if (!isConnected) {
    return;
  }

  const startTime = Date.now();
  const todayStr = new Date().toISOString().split('T')[0];

  // Only sync posts from the last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  try {
    const posts = await PublishedPost.find({
      publishedAt: { $gte: thirtyDaysAgo },
    }).populate('accountId');

    if (posts.length === 0) {
      return;
    }


    // Group posts by account for token-scoped batch requests
    const accountPostsMap = new Map();
    for (const post of posts) {
      const account = post.accountId; // populated SocialAccount document
      if (!account || !account.accessToken || account.accessToken.startsWith('mock-')) {
        continue;
      }

      const accountKey = account._id.toString();
      if (!accountPostsMap.has(accountKey)) {
        accountPostsMap.set(accountKey, { account, posts: [] });
      }
      accountPostsMap.get(accountKey).posts.push(post);
    }

    let totalInsightsUpserted = 0;
    let totalErrors = 0;

    for (const [accountKey, { account, posts: accountPosts }] of accountPostsMap) {
      try {
        // Build batch request items for this account's posts
        const batchRequests = accountPosts.map(post => {
          let metricParam;
          if (account.platform === 'instagram') {
            metricParam = 'views,likes,comments';
          } else {
            metricParam = 'post_impressions_unique,post_reactions_like_total';
          }

          return {
            id: post._id.toString(),
            relativeUrl: `${post.metaPostId}/insights?metric=${metricParam}`,
          };
        });

        // Determine graph host based on auth provider
        const graphHost = (account.platform === 'instagram' && account.authProvider === 'instagram')
          ? 'graph.instagram.com'
          : 'graph.facebook.com';

        // Send batch requests
        const batchResults = await sendBatchRequests(account.accessToken, batchRequests, graphHost);

        // Process results and upsert insights
        for (const post of accountPosts) {
          const postIdStr = post._id.toString();
          const responseBody = batchResults.get(postIdStr);

          if (!responseBody) {
            totalErrors++;
            continue;
          }

          const metrics = extractMetrics(responseBody, account.platform);

          try {
            // Upsert daily snapshot
            await PostInsight.findOneAndUpdate(
              { postId: post._id, dateStr: todayStr },
              {
                campaignId: account.campaignId,
                postId: post._id,
                accountId: account._id,
                dateStr: todayStr,
                views: metrics.views,
                likes: metrics.likes,
                comments: metrics.comments,
              },
              { upsert: true, new: true }
            );

            // Update latest metrics on the PublishedPost document
            await PublishedPost.updateOne(
              { _id: post._id },
              {
                latestViews: metrics.views,
                latestLikes: metrics.likes,
                latestComments: metrics.comments,
              }
            );

            totalInsightsUpserted++;
          } catch (dbErr) {
            totalErrors++;
            // Duplicate key errors are fine
            if (dbErr.code !== 11000) {
              console.error(`❌ [Insight Sync] DB error for post ${post.metaPostId}:`, dbErr.message);
            }
          }
        }
      } catch (accountErr) {
        totalErrors++;
        console.error(`❌ [Insight Sync] Failed to sync insights for account "${account.name}":`, accountErr.message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  } catch (error) {
    console.error('❌ [Insight Sync] Critical error:', error.message);
  }
};
