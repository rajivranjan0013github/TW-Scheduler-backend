/**
 * Insight Sync Worker
 * 
 * Runs once per day at 2:00 AM IST. Fetches per-post lifetime metrics
 * from Meta Graph API and snapshots them into the PostInsight collection for
 * daily tracking. Instagram engagement counts come from media fields while
 * views come from the media insights endpoint.
 */

import SocialAccount from '../models/SocialAccount.js';
import PublishedPost from '../models/PublishedPost.js';
import PostInsight from '../models/PostInsight.js';
import { getDBStatus } from '../config/db.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from '../services/tokenHealthService.js';
import { fetchFacebookPostEngagement, fetchFacebookPostViews } from '../services/facebookMetricsService.js';
import { fetchInstagramMediaMetrics } from '../services/instagramMetricsService.js';

const dateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Runs the daily insight sync job.
 * 
 * 1. Queries all PublishedPosts published in the last 30 days
 * 2. Groups them by account
 * 3. Requests supported post/media metrics from Meta
 * 4. Upserts PostInsight rows for today's date
 * 5. Updates PublishedPost lifetime metric fields
 */
export const runInsightSync = async () => {
  const isConnected = getDBStatus();
  if (!isConnected) {
    return;
  }

  const startTime = Date.now();
  const todayStr = dateKey();

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
      if (!['instagram', 'facebook'].includes(account.platform)) {
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
        const freshAccount = await ensureFreshAccountToken(account);
        if (freshAccount.platform === 'facebook') {
          for (const post of accountPosts) {
            try {
              const [viewResult, engagement] = await Promise.all([
                fetchFacebookPostViews(freshAccount.accessToken, post),
                fetchFacebookPostEngagement(freshAccount.accessToken, post.metaPostId),
              ]);

              const metrics = {
                views: viewResult.views ?? Number(post.latestViews || 0),
                likes: engagement.likes ?? Number(post.latestLikes || 0),
                comments: engagement.comments ?? Number(post.latestComments || 0),
              };

              await PostInsight.findOneAndUpdate(
                { postId: post._id, dateStr: todayStr },
                {
                  campaignId: freshAccount.campaignId,
                  postId: post._id,
                  accountId: freshAccount._id,
                  dateStr: todayStr,
                  views: metrics.views,
                  likes: metrics.likes,
                  comments: metrics.comments,
                },
                { upsert: true, returnDocument: 'after' }
              );

              await PublishedPost.updateOne(
                { _id: post._id },
                {
                  latestViews: metrics.views,
                  latestLikes: metrics.likes,
                  ...(engagement.comments !== null && { latestComments: metrics.comments }),
                  facebookVideoId: viewResult.videoId || post.facebookVideoId || '',
                  viewsSource: viewResult.source,
                }
              );

              totalInsightsUpserted++;
            } catch (postErr) {
              totalErrors++;
              console.error(`❌ [Insight Sync] Facebook metrics failed for post ${post.metaPostId}:`, postErr.message);
            }
          }
          continue;
        }

        let instagramFailures = 0;
        for (const post of accountPosts) {
          const freshMetrics = await fetchInstagramMediaMetrics(freshAccount, post.metaPostId);
          if (!freshMetrics.hasFreshMetrics) {
            totalErrors++;
            instagramFailures++;
            continue;
          }
          if (freshMetrics.errors.length > 0) instagramFailures += freshMetrics.errors.length;
          const metrics = {
            views: freshMetrics.views ?? Number(post.latestViews || 0),
            likes: freshMetrics.likes ?? Number(post.latestLikes || 0),
            comments: freshMetrics.comments ?? Number(post.latestComments || 0),
          };

          try {
            // Upsert daily snapshot
            await PostInsight.findOneAndUpdate(
              { postId: post._id, dateStr: todayStr },
              {
                campaignId: freshAccount.campaignId,
                postId: post._id,
                accountId: freshAccount._id,
                dateStr: todayStr,
                views: metrics.views,
                likes: metrics.likes,
                comments: metrics.comments,
              },
              { upsert: true, returnDocument: 'after' }
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
        if (instagramFailures > 0) {
          console.warn(`[Insight Sync] Instagram account "${freshAccount.name}" had ${instagramFailures} unavailable metric request(s).`);
        }
      } catch (accountErr) {
        totalErrors++;
        await handleProviderAuthFailure(account, accountErr, accountErr.message);
        console.error(`❌ [Insight Sync] Failed to sync insights for account "${account.name}":`, accountErr.message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  } catch (error) {
    console.error('❌ [Insight Sync] Critical error:', error.message);
  }
};
