import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import PublishedPost from '../models/PublishedPost.js';
import Media from '../models/Media.js';
import Folder from '../models/Folder.js';
import SocialAccount from '../models/SocialAccount.js';
import CampaignChannel from '../models/CampaignChannel.js';
import { protect, authorize } from '../middleware/auth.js';
import { addPostToQueue, removePostFromQueue } from '../queues/publisherQueue.js';
import { fetchFacebookPosts, fetchInstagramPosts } from '../queues/feedSyncWorker.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from '../services/tokenHealthService.js';
import { normalizeChannelHandle } from '../utils/campaignChannels.js';

const router = express.Router();
const ADMIN_ROLES = ['owner', 'admin'];
const hasAdminAccess = (user) => ADMIN_ROLES.includes(user?.role) && user?.userType !== 'account_handler';

const getScopedUserId = (req) => {
  if (hasAdminAccess(req.user) && req.query.userId) {
    return req.query.userId;
  }
  return req.user._id;
};

const getActiveCampaignId = (req) => req.query.campaignId || req.body?.campaignId || null;

const requireCampaignId = (req, res) => {
  const campaignId = getActiveCampaignId(req);
  if (!campaignId) {
    res.status(400).json({ message: 'Campaign is required.' });
    return null;
  }
  return campaignId;
};

const idsToStrings = (items = []) => items.map((item) => String(item?._id || item));
const validScheduleModes = new Set(['auto', 'manual', 'hybrid']);
const terminalManualStatuses = new Set(['posted_manual', 'published', 'published_auto', 'cancelled']);
const dashboardUpcomingStatuses = ['scheduled', 'publishing'];
const MANUAL_POST_FEED_SYNC_MAX_PAGES = 1;
const MANUAL_POST_FEED_SYNC_LIMIT = 10;

const normalizeScheduleMode = (mode) => (
  validScheduleModes.has(mode) ? mode : 'auto'
);
const getScheduleRangeQuery = (query = {}) => {
  const range = {};
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;

  if (from && !Number.isNaN(from.getTime())) {
    if (!String(query.from).includes('T')) {
      from.setHours(0, 0, 0, 0);
    }
    range.$gte = from;
  }

  if (to && !Number.isNaN(to.getTime())) {
    if (!String(query.to).includes('T')) {
      to.setHours(23, 59, 59, 999);
    }
    range.$lte = to;
  }

  return Object.keys(range).length > 0 ? { scheduledAt: range } : {};
};
const splitQueryList = (value) => String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const getSchedulerPostListQuery = (campaignId, query = {}) => {
  const accountIds = splitQueryList(query.accountIds);
  const statuses = splitQueryList(query.statuses);
  const filters = {
    campaignId,
    ...getScheduleRangeQuery(query),
  };

  if (statuses.length > 0) {
    filters.status = { $in: statuses };
  }

  if (accountIds.length > 0) {
    filters.$or = [
      { socialAccountIds: { $in: accountIds } },
      { campaignChannelIds: { $in: accountIds } },
    ];
  }

  return filters;
};
const populateSchedulerPostList = (query) => query
  .select('campaignId socialAccountIds campaignChannelIds mediaIds caption scheduledAt scheduleMode status publishSource manualDownloadedAt manualPostedAt manualPostUrl publishError platformSpecifics publishResponseId createdAt updatedAt')
  .populate({ path: 'socialAccountIds', select: 'username name platform avatarUrl isConnected tokenStatus' })
  .populate({ path: 'campaignChannelIds', select: 'requestedHandle normalizedHandle displayName platform status socialAccountId assignedHandlerEmail assignedHandlerUserId' })
  .populate({ path: 'mediaIds', select: 'name type url folderId caption' })
  .sort({ scheduledAt: 1 })
  .lean();

const getInitialStatusForMode = (mode) => (
  mode === 'manual' ? 'manual_ready' : 'scheduled'
);

const shouldQueuePost = (post) => (
  ['auto', 'hybrid'].includes(post.scheduleMode || 'auto') && post.status === 'scheduled'
);

const getUniqueIds = (items = []) => (
  [...new Set(idsToStrings(items).filter(Boolean))]
);

const activeQueueStatuses = ['scheduled', 'manual_ready', 'downloaded', 'publishing', 'paused'];

const getDateBoundary = (value, fallback) => {
  const date = value ? new Date(value) : fallback;
  return date && !Number.isNaN(date.getTime()) ? date : fallback;
};

const toDebugDate = (date) => ({
  local: date?.toString?.() || null,
  iso: date?.toISOString?.() || null,
  timestamp: date?.getTime?.() || null,
});

const summarizeTodayTrackingPost = (post) => ({
  _id: String(post._id || ''),
  accountId: String(post.accountId || ''),
  metaPostId: post.metaPostId || '',
  platform: post.platform || '',
  mediaType: post.mediaType || '',
  facebookVideoId: post.facebookVideoId || '',
  publishedAt: toDebugDate(post.publishedAt),
  lastSyncedAt: toDebugDate(post.lastSyncedAt),
  mediaUrl: post.mediaUrl || '',
  videoUrl: post.videoUrl || '',
  permalink: post.permalink || '',
  contentPreview: (post.content || '').slice(0, 120),
});

const isVideoPublishedPost = (post = {}) => {
  const mediaType = String(post.mediaType || '').toUpperCase();
  return mediaType.includes('VIDEO') || Boolean(post.videoUrl || post.facebookVideoId);
};

const getManualPostVerificationStart = (post) => {
  const downloadedAt = post.manualDownloadedAt ? new Date(post.manualDownloadedAt) : new Date();
  const downloadedAtMs = downloadedAt.getTime();
  const baseMs = Number.isFinite(downloadedAtMs) ? downloadedAtMs : Date.now();
  return new Date(baseMs);
};

const getPostConnectedAccountIds = (post) => ([
  ...idsToStrings(post.socialAccountIds),
  ...idsToStrings((post.campaignChannelIds || [])
    .map((channel) => channel?.socialAccountId)
    .filter(Boolean)),
]);

const syncRecentMetaFeedForManualPost = async (post, { verificationStart } = {}) => {
  const accountIds = getUniqueIds(getPostConnectedAccountIds(post));
  if (accountIds.length === 0) {
    return { accountsChecked: [], syncedPosts: [], matchingPosts: [], errors: [] };
  }

  const accounts = await SocialAccount.find({
    _id: { $in: accountIds },
    isConnected: true,
    platform: { $in: ['facebook', 'instagram'] },
  });
  const syncedPosts = [];
  const matchingPosts = [];
  const errors = [];

  for (const account of accounts) {
    try {
      const freshAccount = await ensureFreshAccountToken(account);
      const fetchedPosts = freshAccount.platform === 'facebook'
        ? await fetchFacebookPosts(freshAccount, {
          maxPages: MANUAL_POST_FEED_SYNC_MAX_PAGES,
          limit: MANUAL_POST_FEED_SYNC_LIMIT,
        })
        : await fetchInstagramPosts(freshAccount, {
          maxPages: MANUAL_POST_FEED_SYNC_MAX_PAGES,
          limit: MANUAL_POST_FEED_SYNC_LIMIT,
        });

      console.log('[manual-posted] live feed fetched', {
        scheduledPostId: String(post._id || ''),
        accountId: String(freshAccount._id || ''),
        platform: freshAccount.platform,
        username: freshAccount.username || '',
        providerAccountId: freshAccount.accountId || '',
        limit: MANUAL_POST_FEED_SYNC_LIMIT,
        fetchedCount: fetchedPosts.length,
        verificationStart: toDebugDate(verificationStart),
        fetchedVideos: fetchedPosts
          .filter(isVideoPublishedPost)
          .map((postData) => summarizeTodayTrackingPost({
            ...postData,
            accountId: freshAccount._id,
          })),
        allFetchedPosts: fetchedPosts.map((postData) => summarizeTodayTrackingPost({
          ...postData,
          accountId: freshAccount._id,
        })),
      });

      for (const postData of fetchedPosts) {
        const cachedPost = await PublishedPost.findOneAndUpdate(
          { userId: freshAccount.userId, metaPostId: postData.metaPostId },
          {
            userId: freshAccount.userId,
            campaignId: freshAccount.campaignId,
            accountId: freshAccount._id,
            ...postData,
            lastSyncedAt: new Date(),
            ...(postData.latestViews !== undefined && { latestViews: postData.latestViews }),
            ...(postData.latestLikes !== undefined && { latestLikes: postData.latestLikes }),
            ...(postData.latestComments !== undefined && { latestComments: postData.latestComments }),
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        ).lean();

        syncedPosts.push(cachedPost);
        const publishedAt = cachedPost?.publishedAt ? new Date(cachedPost.publishedAt).getTime() : NaN;
        if (isVideoPublishedPost(cachedPost) && Number.isFinite(publishedAt) && publishedAt >= verificationStart.getTime()) {
          matchingPosts.push(cachedPost);
        }
      }
    } catch (error) {
      errors.push({
        accountId: String(account._id || ''),
        platform: account.platform || '',
        message: error.message,
      });
      await handleProviderAuthFailure(account, error, error.message);
      console.error('[manual-posted] live feed fetch failed', {
        scheduledPostId: String(post._id || ''),
        accountId: String(account._id || ''),
        platform: account.platform || '',
        message: error.message,
      });
    }
  }

  return {
    accountsChecked: accounts.map((account) => ({
      _id: String(account._id || ''),
      platform: account.platform || '',
      username: account.username || '',
      providerAccountId: account.accountId || '',
    })),
    syncedPosts,
    matchingPosts,
    errors,
  };
};

const canAccessManualPost = async (post, user) => {
  if (!post || !user) return false;
  if (hasAdminAccess(user)) return true;
  if (String(post.userId) === String(user._id)) return true;

  const postAccountIds = idsToStrings(post.socialAccountIds);
  if (postAccountIds.length > 0) {
    const ownedAccount = await SocialAccount.exists({
      _id: { $in: postAccountIds },
      userId: user._id,
    });
    if (ownedAccount) return true;
  }

  const postChannelIds = idsToStrings(post.campaignChannelIds);
  if (postChannelIds.length === 0) return false;
  const userEmail = (user.email || '').trim().toLowerCase();
  const assignedChannel = await CampaignChannel.exists({
    _id: { $in: postChannelIds },
    $or: [
      { assignedHandlerUserId: user._id },
      ...(userEmail ? [{ assignedHandlerEmail: userEmail }] : []),
    ],
  });

  return Boolean(assignedChannel);
};

const withPostCaption = (platformSpecifics, postCaption, type) => {
  const nextSpecifics = platformSpecifics
    ? { ...platformSpecifics }
    : { type: type || 'reels' };

  if (nextSpecifics.youtube) {
    nextSpecifics.youtube = {
      ...nextSpecifics.youtube,
      description: postCaption,
    };
  }

  return nextSpecifics;
};

const getAccountMatchHandles = (account = {}) => (
  [
    normalizeChannelHandle(account.username),
    normalizeChannelHandle(account.name),
    normalizeChannelHandle(account.accountId),
  ].filter(Boolean)
);

const normalizeChannelTargets = ({ channelTargets = [], socialAccountIds = [], campaignChannelIds = [] } = {}) => {
  const normalizedTargets = channelTargets
    .map((target) => ({
      socialAccountId: target?.socialAccountId || null,
      campaignChannelId: target?.campaignChannelId || null,
    }))
    .filter((target) => target.socialAccountId || target.campaignChannelId);

  if (normalizedTargets.length > 0) return normalizedTargets;

  const accountIds = getUniqueIds(socialAccountIds);
  const channelIds = getUniqueIds(campaignChannelIds);
  if (accountIds.length > 0) {
    return accountIds.map((accountId, index) => ({
      socialAccountId: accountId,
      campaignChannelId: channelIds[index] || null,
    }));
  }

  return channelIds.map((channelId) => ({
    socialAccountId: null,
    campaignChannelId: channelId,
  }));
};

const validateSchedulingAccess = async ({ campaignId, socialAccountIds, campaignChannelIds, channelTargets, mediaIds, allowDisconnectedAccounts = false }) => {
  const accountIds = idsToStrings(socialAccountIds);
  const channelIds = idsToStrings(campaignChannelIds);
  const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });
  const mediaIdList = idsToStrings(mediaIds);

  if (targets.length === 0 || mediaIdList.length === 0) {
    return { ok: false, message: 'Must select publishing channels and at least one media file' };
  }

  const mediaItems = await Media.find({ _id: { $in: mediaIdList }, campaignId }).select('_id socialAccountIds');
  if (mediaItems.length !== mediaIdList.length) {
    return { ok: false, message: 'One or more selected media assets were not found.' };
  }

  if (!allowDisconnectedAccounts) {
    if (accountIds.length === 0) {
      return { ok: false, message: 'One or more selected publishing channels are not connected.' };
    }
    const accounts = await CampaignChannel.find({
      campaignId,
      status: 'verified',
      socialAccountId: { $in: accountIds },
    }).select('socialAccountId');
    const verifiedAccountIds = new Set(accounts.map((channel) => String(channel.socialAccountId)));

    if (!accountIds.every((accountId) => verifiedAccountIds.has(String(accountId)))) {
      return { ok: false, message: 'One or more selected publishing channels are not connected.' };
    }
    return { ok: true };
  }

  if (channelIds.length > 0) {
    const channels = await CampaignChannel.find({
      _id: { $in: channelIds },
      campaignId,
    }).select('_id status socialAccountId assignedHandlerEmail assignedHandlerUserId').lean();
    if (channels.length !== getUniqueIds(channelIds).length) {
      return { ok: false, message: 'One or more selected channels are not assigned to this campaign.' };
    }
    const unusableManualChannel = channels.some((channel) => (
      channel.status !== 'verified'
      && !channel.socialAccountId
      && !channel.assignedHandlerEmail
      && !channel.assignedHandlerUserId
    ));
    if (unusableManualChannel) {
      return { ok: false, message: 'Assign a handler email before scheduling an unverified channel manually.' };
    }
  }

  if (accountIds.length === 0) {
    return { ok: true };
  }

  const selectedAccounts = await SocialAccount.find({ _id: { $in: accountIds } })
    .select('_id platform username name accountId')
    .lean();
  if (selectedAccounts.length !== accountIds.length) {
    return { ok: false, message: 'One or more selected publishing channels were not found.' };
  }

  const accountKeys = new Set(
    selectedAccounts.flatMap((account) => (
      getAccountMatchHandles(account).map((handle) => `${account.platform}:${handle}`)
    ))
  );
  const assignedChannels = await CampaignChannel.find({ campaignId })
    .select('platform normalizedHandle')
    .lean();
  const assignedKeys = new Set(
    assignedChannels.map((channel) => `${channel.platform}:${normalizeChannelHandle(channel.normalizedHandle)}`)
  );

  const allAccountsAssigned = selectedAccounts.every((account) => (
    getAccountMatchHandles(account).some((handle) => assignedKeys.has(`${account.platform}:${handle}`))
  ));
  if (!allAccountsAssigned || accountKeys.size === 0) {
    return { ok: false, message: 'One or more selected channels are not assigned to this campaign.' };
  }

  return { ok: true };
};

// @desc    Get all scheduled and published posts
// @route   GET /api/scheduler
// @access  Private
router.get('/dashboard-summary', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const accountIds = new Set(String(req.query.accountIds || '').split(',').filter(Boolean));
      const upcoming = mockStore.scheduledPosts
        .filter((post) => dashboardUpcomingStatuses.includes(post.status))
        .filter((post) => (
          accountIds.size === 0
          || (post.socialAccountIds || []).some((accountId) => accountIds.has(String(accountId?._id || accountId)))
        ))
        .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      return res.status(200).json({
        upcomingCount: upcoming.length,
        upcomingPosts: upcoming.slice(0, 3),
      });
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const accountIds = String(req.query.accountIds || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const query = {
      campaignId,
      status: { $in: dashboardUpcomingStatuses },
    };
    if (accountIds.length > 0) {
      query.socialAccountIds = { $in: accountIds };
    }

    const [upcomingCount, upcomingPosts] = await Promise.all([
      ScheduledPost.countDocuments(query),
      populateSchedulerPostList(ScheduledPost.find(query).limit(3)),
    ]);

    res.status(200).json({ upcomingCount, upcomingPosts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      // Sort in-memory posts by date
      const rangeQuery = getScheduleRangeQuery(req.query);
      const sorted = [...mockStore.scheduledPosts]
        .filter((post) => {
          const scheduledAt = new Date(post.scheduledAt);
          if (rangeQuery.scheduledAt?.$gte && scheduledAt < rangeQuery.scheduledAt.$gte) return false;
          if (rangeQuery.scheduledAt?.$lte && scheduledAt > rangeQuery.scheduledAt.$lte) return false;
          return true;
        })
        .map(post => {
          if (post.status === 'published' || post.status === 'published_auto') {
            return {
              ...post,
              latestViews: 1250,
              latestLikes: 84,
              latestComments: 12,
              lastSyncedAt: new Date(),
              permalink: 'https://instagram.com',
              viewsSource: 'instagram',
              publishedAt: post.scheduledAt,
            };
          }
          return post;
        })
        .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      return res.status(200).json(sorted);
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const posts = await populateSchedulerPostList(
      ScheduledPost.find(getSchedulerPostListQuery(campaignId, req.query))
    );
    
    // Enrich with PublishedPost metrics
    const allMetaIds = [];
    const postMetaIdsMap = new Map(); // post._id -> array of metaPostIds
    
    posts.forEach(post => {
      if (post.publishResponseId) {
        let ids = [];
        try {
          const parsed = JSON.parse(post.publishResponseId);
          if (Array.isArray(parsed)) {
            ids = parsed.map(item => item.publishId || item.id || item).filter(Boolean).map(String);
          } else if (parsed && typeof parsed === 'object') {
            ids = [parsed.publishId || parsed.id || parsed].filter(Boolean).map(String);
          } else {
            ids = [String(post.publishResponseId)];
          }
        } catch (e) {
          ids = [String(post.publishResponseId)];
        }
        if (ids.length > 0) {
          postMetaIdsMap.set(String(post._id), ids);
          allMetaIds.push(...ids);
        }
      }
    });

    const manualUrls = posts.map(p => p.manualPostUrl).filter(Boolean);
    
    const query = { $or: [] };
    if (allMetaIds.length > 0) query.$or.push({ metaPostId: { $in: allMetaIds } });
    if (manualUrls.length > 0) query.$or.push({ permalink: { $in: manualUrls } });
    
    const publishedPosts = (allMetaIds.length > 0 || manualUrls.length > 0)
      ? await PublishedPost.find(query)
          .select('metaPostId latestViews latestLikes latestComments lastSyncedAt permalink viewsSource publishedAt content accountId')
          .lean()
      : [];
    
    const metaIdToPubMap = new Map(publishedPosts.filter(p => p.metaPostId).map(p => [p.metaPostId, p]));
    const permalinkToPubMap = new Map(publishedPosts.filter(p => p.permalink).map(p => [p.permalink, p]));

    // Heuristic matching fallback for unmatched completed posts (e.g. manual posts with empty manualPostUrl)
    const unmatchedPosts = posts.filter(p => {
      const isCompleted = ['published', 'published_auto', 'posted_manual'].includes(p.status);
      if (!isCompleted) return false;
      const metaIds = postMetaIdsMap.get(String(p._id)) || [];
      const hasIdMatch = metaIds.some(id => metaIdToPubMap.has(id));
      const hasUrlMatch = p.manualPostUrl && permalinkToPubMap.has(p.manualPostUrl);
      return !hasIdMatch && !hasUrlMatch;
    });

    if (unmatchedPosts.length > 0) {
      const accountIds = getUniqueIds(unmatchedPosts.flatMap(p => p.socialAccountIds || []));
      const candidatePubs = accountIds.length > 0
        ? await PublishedPost.find({
            accountId: { $in: accountIds }
          })
          .select('accountId metaPostId latestViews latestLikes latestComments lastSyncedAt permalink viewsSource publishedAt content')
          .lean()
        : [];
      
      const pubsByAccount = new Map();
      candidatePubs.forEach(pub => {
        const accId = String(pub.accountId);
        if (!pubsByAccount.has(accId)) pubsByAccount.set(accId, []);
        pubsByAccount.get(accId).push(pub);
      });
      
      const normalizeString = (str) => {
        if (!str) return '';
        return str.toLowerCase().replace(/[^a-z0-9]/g, '');
      };
      
      unmatchedPosts.forEach(post => {
        const postAccounts = idsToStrings(post.socialAccountIds || []);
        const postTime = new Date(post.manualPostedAt || post.scheduledAt).getTime();
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        
        let bestMatch = null;
        
        for (const accId of postAccounts) {
          const pubs = pubsByAccount.get(accId) || [];
          
          // Filter candidate posts published within 24 hours of scheduled/manual time
          const timeCandidates = pubs.filter(pub => {
            const pubTime = new Date(pub.publishedAt).getTime();
            return Math.abs(pubTime - postTime) <= ONE_DAY_MS;
          });
          
          if (timeCandidates.length === 0) continue;
          
          if (timeCandidates.length === 1) {
            bestMatch = timeCandidates[0];
            break;
          }
          
          // Match by caption similarity (using alphanumeric normalized string check)
          const postNorm = normalizeString(post.caption).substring(0, 20);
          if (postNorm) {
            const captionMatch = timeCandidates.find(pub => {
              const pubNorm = normalizeString(pub.content);
              return pubNorm.includes(postNorm) || postNorm.includes(pubNorm.substring(0, 20));
            });
            if (captionMatch) {
              bestMatch = captionMatch;
              break;
            }
          }
          
          // Take closest time match
          bestMatch = timeCandidates.sort((a, b) => {
            const aDiff = Math.abs(new Date(a.publishedAt).getTime() - postTime);
            const bDiff = Math.abs(new Date(b.publishedAt).getTime() - postTime);
            return aDiff - bDiff;
          })[0];
        }
        
        if (bestMatch) {
          postMetaIdsMap.set(String(post._id), [bestMatch.metaPostId]);
          metaIdToPubMap.set(bestMatch.metaPostId, bestMatch);
        }
      });
    }

    const enrichedPosts = posts.map(post => {
      const matchingPubs = [];
      
      const metaIds = postMetaIdsMap.get(String(post._id)) || [];
      metaIds.forEach(metaId => {
        if (metaIdToPubMap.has(metaId)) {
          matchingPubs.push(metaIdToPubMap.get(metaId));
        }
      });
      
      if (post.manualPostUrl && permalinkToPubMap.has(post.manualPostUrl)) {
        matchingPubs.push(permalinkToPubMap.get(post.manualPostUrl));
      }
      
      if (matchingPubs.length > 0) {
        const totalViews = matchingPubs.reduce((sum, p) => sum + (p.latestViews || 0), 0);
        const totalLikes = matchingPubs.reduce((sum, p) => sum + (p.latestLikes || 0), 0);
        const totalComments = matchingPubs.reduce((sum, p) => sum + (p.latestComments || 0), 0);
        const primaryPub = matchingPubs[0];
        
        return {
          ...post,
          latestViews: totalViews,
          latestLikes: totalLikes,
          latestComments: totalComments,
          lastSyncedAt: primaryPub.lastSyncedAt,
          permalink: primaryPub.permalink,
          viewsSource: primaryPub.viewsSource,
          publishedAt: primaryPub.publishedAt,
        };
      }
      return post;
    });

    res.status(200).json(enrichedPosts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create a scheduled post
// @route   POST /api/scheduler
// @access  Private (Owner, Admin, Editor)
router.post('/', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { socialAccountIds, campaignChannelIds, channelTargets, mediaIds, caption, scheduledAt, platformSpecifics } = req.body;
  const scheduleMode = normalizeScheduleMode(req.body.scheduleMode);

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const scheduledDate = new Date(scheduledAt);
    let postCaption = caption || '';

    if (!isConnected) {
      if (!postCaption && mediaIds?.[0]) {
        const mediaItem = mockStore.media.find(m => String(m._id) === String(mediaIds[0]));
        postCaption = mediaItem?.caption || '';
      }
      const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });
      const newPosts = targets.map((target) => ({
        _id: `sp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
        campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
        mediaIds,
        caption: postCaption,
        scheduledAt: scheduledDate,
        scheduleMode,
        status: getInitialStatusForMode(scheduleMode),
        platformSpecifics: withPostCaption(platformSpecifics, postCaption, platformSpecifics?.type || 'reels'),
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      mockStore.scheduledPosts.push(...newPosts);
      return targets.length === 1
        ? res.status(201).json(newPosts[0])
        : res.status(201).json({
          message: `Successfully scheduled ${newPosts.length} posts.`,
          postsCount: newPosts.length,
          posts: newPosts,
        });
    }

    const access = await validateSchedulingAccess({
      campaignId,
      socialAccountIds,
      campaignChannelIds,
      channelTargets,
      mediaIds,
      allowDisconnectedAccounts: scheduleMode === 'manual',
    });
    if (!access.ok) {
      return res.status(400).json({ message: access.message });
    }

    if (!postCaption && mediaIds?.[0]) {
      const mediaItem = await Media.findOne({ _id: mediaIds[0], campaignId }).select('caption');
      postCaption = mediaItem?.caption || '';
    }

    const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });
    const posts = [];

    for (const target of targets) {
      const post = await ScheduledPost.create({
        userId: req.user._id,
        campaignId,
        socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
        campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
        mediaIds,
        caption: postCaption,
        scheduledAt: scheduledDate,
        scheduleMode,
        status: getInitialStatusForMode(scheduleMode),
        platformSpecifics: withPostCaption(platformSpecifics, postCaption, platformSpecifics?.type || 'reels'),
      });
      if (shouldQueuePost(post)) {
        await addPostToQueue(post);
      }
      posts.push(post);
    }

    res.status(201).json(posts.length === 1
      ? posts[0]
      : {
        message: `Successfully scheduled ${posts.length} posts.`,
        postsCount: posts.length,
        posts,
      });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Bulk Schedule posts sequentially
// @route   POST /api/scheduler/bulk
// @access  Private (Owner, Admin, Editor)
router.post('/bulk', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { socialAccountIds, campaignChannelIds, channelTargets, mediaIds, caption, startDate, intervalHours, type, platformSpecifics } = req.body;
  const scheduleMode = normalizeScheduleMode(req.body.scheduleMode);
  const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });

  if (targets.length === 0 || !mediaIds || mediaIds.length === 0) {
    return res.status(400).json({ message: 'Must select publishing channels and at least one media file' });
  }

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const baseDate = new Date(startDate || Date.now());
    const intervalMs = (parseFloat(intervalHours) || 2) * 60 * 60 * 1000;
    const createdPosts = [];
    const mediaCaptionMap = new Map();

    if (isConnected) {
      const access = await validateSchedulingAccess({
        campaignId,
        socialAccountIds,
        campaignChannelIds,
        channelTargets,
        mediaIds,
        allowDisconnectedAccounts: scheduleMode === 'manual',
      });
      if (!access.ok) {
        return res.status(400).json({ message: access.message });
      }

      const mediaItems = await Media.find({
        _id: { $in: idsToStrings(mediaIds) },
        campaignId,
      }).select('_id caption');

      mediaItems.forEach((mediaItem) => {
        mediaCaptionMap.set(String(mediaItem._id), mediaItem.caption || '');
      });
    } else {
      mockStore.media.forEach((mediaItem) => {
        mediaCaptionMap.set(String(mediaItem._id), mediaItem.caption || '');
      });
    }

    // For bulk scheduling: we loop through the publishing channels, and for each channel
    // we sequence the media files with the specified hour gap.
    // e.g. 5 accounts, 50 reels = 250 scheduled posts
    let index = 0;
    for (const target of targets) {
      let currentScheduleTime = new Date(baseDate.getTime());
      
      for (const mediaId of mediaIds) {
        const scheduledTime = new Date(currentScheduleTime.getTime());
        const mediaCaption = mediaCaptionMap.get(String(mediaId)) || '';
        const postCaption = mediaCaption || caption || '';
        const postPlatformSpecifics = withPostCaption(platformSpecifics, postCaption, type);
        
        if (!isConnected) {
          const newPost = {
            _id: `sp_bulk_${Date.now()}_${index++}`,
            socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
            campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
            mediaIds: [mediaId],
            caption: postCaption,
            scheduledAt: scheduledTime,
            scheduleMode,
            status: getInitialStatusForMode(scheduleMode),
            platformSpecifics: postPlatformSpecifics,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockStore.scheduledPosts.push(newPost);
          createdPosts.push(newPost);
        } else {
          const post = await ScheduledPost.create({
            userId: req.user._id,
            campaignId,
            socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
            campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
            mediaIds: [mediaId],
            caption: postCaption,
            scheduledAt: scheduledTime,
            scheduleMode,
            status: getInitialStatusForMode(scheduleMode),
            platformSpecifics: postPlatformSpecifics,
          });
          if (shouldQueuePost(post)) {
            await addPostToQueue(post);
          }
          createdPosts.push(post);
        }

        // Increment schedule time for next media file on this account
        currentScheduleTime = new Date(currentScheduleTime.getTime() + intervalMs);
      }
    }

    res.status(201).json({
      message: `Successfully scheduled ${createdPosts.length} posts.`,
      postsCount: createdPosts.length,
      posts: createdPosts
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Bulk schedule carousel sets sequentially
// @route   POST /api/scheduler/carousels
// @access  Private (Owner, Admin, Editor)
router.post('/carousels', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { socialAccountIds, campaignChannelIds, channelTargets, carouselSetIds, caption, startDate, intervalHours, platformSpecifics } = req.body;
  const scheduleMode = normalizeScheduleMode(req.body.scheduleMode);
  const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });

  if (targets.length === 0 || !carouselSetIds || carouselSetIds.length === 0) {
    return res.status(400).json({ message: 'Must select publishing channels and at least one carousel set' });
  }

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const baseDate = new Date(startDate || Date.now());
    const intervalMs = (parseFloat(intervalHours) || 2) * 60 * 60 * 1000;
    const accountIds = getUniqueIds(socialAccountIds);
    const channelIds = getUniqueIds(campaignChannelIds);
    const setIds = getUniqueIds(carouselSetIds);
    const createdPosts = [];

    if (!isConnected) {
      let index = 0;
      for (const target of targets) {
        let currentScheduleTime = new Date(baseDate.getTime());
        for (const setId of setIds) {
          const folder = mockStore.folders.find(f => String(f._id) === String(setId));
          const folderMedia = mockStore.media.filter(m => String(m.folderId) === String(setId));
          const orderedIds = (folder?.carouselOrder || []).filter(mediaId => folderMedia.some(m => String(m._id) === String(mediaId)));
          const unorderedIds = folderMedia.map(m => m._id).filter(mediaId => !orderedIds.includes(mediaId));
          const mediaIds = [...orderedIds, ...unorderedIds];
          if (mediaIds.length === 0) continue;

          const postCaption = folder?.carouselCaption || caption || '';
          const post = {
            _id: `sp_carousel_${Date.now()}_${index++}`,
            socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
            campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
            mediaIds,
            caption: postCaption,
            scheduledAt: new Date(currentScheduleTime.getTime()),
            scheduleMode,
            status: getInitialStatusForMode(scheduleMode),
            platformSpecifics: {
              ...(platformSpecifics || {}),
              type: 'carousel',
              carouselSetId: setId,
              carouselSetName: folder?.name || 'Carousel Set',
              carouselOrder: mediaIds,
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockStore.scheduledPosts.push(post);
          createdPosts.push(post);
          currentScheduleTime = new Date(currentScheduleTime.getTime() + intervalMs);
        }
      }

      return res.status(201).json({
        message: `Successfully scheduled ${createdPosts.length} carousel posts.`,
        postsCount: createdPosts.length,
        posts: createdPosts,
      });
    }

    if (scheduleMode === 'manual') {
      if (channelIds.length > 0) {
        const channels = await CampaignChannel.find({
          _id: { $in: channelIds },
          campaignId,
        }).select('_id status socialAccountId assignedHandlerEmail assignedHandlerUserId').lean();
        if (channels.length !== channelIds.length) {
          return res.status(400).json({ message: 'One or more selected channels are not assigned to this campaign.' });
        }
        const unusableManualChannel = channels.some((channel) => (
          channel.status !== 'verified'
          && !channel.socialAccountId
          && !channel.assignedHandlerEmail
          && !channel.assignedHandlerUserId
        ));
        if (unusableManualChannel) {
          return res.status(400).json({ message: 'Assign a handler email before scheduling an unverified channel manually.' });
        }
      }
      const selectedAccounts = await SocialAccount.find({ _id: { $in: accountIds } })
        .select('_id platform username name accountId')
        .lean();
      const assignedChannels = await CampaignChannel.find({ campaignId })
        .select('platform normalizedHandle')
        .lean();
      const assignedKeys = new Set(
        assignedChannels.map((channel) => `${channel.platform}:${normalizeChannelHandle(channel.normalizedHandle)}`)
      );
      const allAccountsAssigned = accountIds.length === 0 || (selectedAccounts.length === accountIds.length && selectedAccounts.every((account) => (
        getAccountMatchHandles(account).some((handle) => assignedKeys.has(`${account.platform}:${handle}`))
      )));
      if (!allAccountsAssigned) {
        return res.status(400).json({ message: 'One or more selected channels are not assigned to this campaign.' });
      }
    } else {
      if (accountIds.length === 0) {
        return res.status(400).json({ message: 'One or more selected publishing channels are not connected.' });
      }
      const channelAccess = await CampaignChannel.find({
        campaignId,
        status: 'verified',
        socialAccountId: { $in: accountIds },
      }).select('socialAccountId');
      const verifiedAccountIds = new Set(channelAccess.map((channel) => String(channel.socialAccountId)));
      if (!accountIds.every((accountId) => verifiedAccountIds.has(String(accountId)))) {
        return res.status(400).json({ message: 'One or more selected publishing channels are not connected.' });
      }
    }

    const folders = await Folder.find({
      _id: { $in: setIds },
      campaignId,
      kind: 'carousel_set',
    }).lean();
    if (folders.length !== setIds.length) {
      return res.status(400).json({ message: 'One or more carousel sets were not found.' });
    }

    const mediaItems = await Media.find({
      campaignId,
      folderId: { $in: setIds },
      type: { $in: ['image', 'video'] },
    }).select('_id folderId createdAt');
    const mediaByFolder = new Map();
    mediaItems.forEach((item) => {
      const folderId = String(item.folderId);
      if (!mediaByFolder.has(folderId)) mediaByFolder.set(folderId, []);
      mediaByFolder.get(folderId).push(item);
    });

    for (const target of targets) {
      let currentScheduleTime = new Date(baseDate.getTime());

      for (const setId of setIds) {
        const folder = folders.find(f => String(f._id) === String(setId));
        const folderMedia = mediaByFolder.get(String(setId)) || [];
        const mediaIdSet = new Set(folderMedia.map(item => String(item._id)));
        const orderedIds = (folder.carouselOrder || [])
          .map(id => String(id))
          .filter(mediaId => mediaIdSet.has(mediaId));
        const unorderedIds = folderMedia
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
          .map(item => String(item._id))
          .filter(mediaId => !orderedIds.includes(mediaId));
        const mediaIds = [...orderedIds, ...unorderedIds];

        if (mediaIds.length === 0) {
          return res.status(400).json({ message: `${folder.name} has no supported carousel slides.` });
        }

        const postCaption = folder.carouselCaption || caption || '';
        const postPlatformSpecifics = withPostCaption({
          ...(platformSpecifics || {}),
          type: 'carousel',
          carouselSetId: folder._id,
          carouselSetName: folder.name,
          carouselOrder: mediaIds,
        }, postCaption, 'carousel');

        const post = await ScheduledPost.create({
          userId: req.user._id,
          campaignId,
          socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
          campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
          mediaIds,
          caption: postCaption,
          scheduledAt: new Date(currentScheduleTime.getTime()),
          scheduleMode,
          status: getInitialStatusForMode(scheduleMode),
          platformSpecifics: postPlatformSpecifics,
        });
        if (shouldQueuePost(post)) {
          await addPostToQueue(post);
        }
        createdPosts.push(post);
        currentScheduleTime = new Date(currentScheduleTime.getTime() + intervalMs);
      }
    }

    res.status(201).json({
      message: `Successfully scheduled ${createdPosts.length} carousel posts.`,
      postsCount: createdPosts.length,
      posts: createdPosts,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Mark creator access/download on a manual or hybrid post
// @route   POST /api/scheduler/:id/downloaded
// @access  Private
router.post('/:id/downloaded', protect, async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const post = mockStore.scheduledPosts.find(p => p._id === id);
      if (!post) return res.status(404).json({ message: 'Post not found' });
      post.manualDownloadedAt = new Date();
      if (post.status === 'manual_ready') post.status = 'downloaded';
      post.updatedAt = new Date();
      return res.status(200).json(post);
    }

    const post = await ScheduledPost.findById(id)
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds');
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (!['manual', 'hybrid'].includes(post.scheduleMode || 'auto')) {
      return res.status(400).json({ message: 'Only manual or hybrid posts can be downloaded by creators.' });
    }
    if (!(await canAccessManualPost(post, req.user))) {
      return res.status(403).json({ message: 'Access denied for this scheduled post.' });
    }
    if (terminalManualStatuses.has(post.status)) {
      return res.status(400).json({ message: 'This post is already complete or cancelled.' });
    }

    post.manualDownloadedAt = new Date();
    if (post.status === 'manual_ready') post.status = 'downloaded';
    await post.save();

    res.status(200).json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Mark a manual/hybrid post as posted by the creator
// @route   POST /api/scheduler/:id/manual-posted
// @access  Private
router.post('/:id/manual-posted', protect, async (req, res) => {
  const { id } = req.params;
  const { manualPostUrl = '' } = req.body || {};

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const post = mockStore.scheduledPosts.find(p => p._id === id);
      if (!post) return res.status(404).json({ message: 'Post not found' });
      post.status = 'posted_manual';
      post.publishSource = 'creator';
      post.manualPostedAt = new Date();
      post.manualPostUrl = manualPostUrl;
      post.postedByUserId = req.user._id;
      post.updatedAt = new Date();
      return res.status(200).json(post);
    }

    const post = await ScheduledPost.findById(id)
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds');
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (!['manual', 'hybrid'].includes(post.scheduleMode || 'auto')) {
      return res.status(400).json({ message: 'Only manual or hybrid posts can be marked as manually posted.' });
    }
    if (!(await canAccessManualPost(post, req.user))) {
      return res.status(403).json({ message: 'Access denied for this scheduled post.' });
    }
    if (['posted_manual', 'published', 'published_auto'].includes(post.status)) {
      return res.status(200).json(post);
    }

    if (!post.manualDownloadedAt) {
      post.manualDownloadedAt = new Date();
      if (post.status === 'manual_ready') post.status = 'downloaded';
      await post.save();
    }

    const verificationStart = getManualPostVerificationStart(post);
    const verification = await syncRecentMetaFeedForManualPost(post, { verificationStart });
    console.log('[manual-posted] verification result', {
      scheduledPostId: String(post._id || ''),
      manualDownloadedAt: toDebugDate(post.manualDownloadedAt),
      verificationStart: toDebugDate(verificationStart),
      accountsChecked: verification.accountsChecked,
      syncedCount: verification.syncedPosts.length,
      matchingCount: verification.matchingPosts.length,
      errors: verification.errors,
      matchingPosts: verification.matchingPosts.map(summarizeTodayTrackingPost),
    });

    if (verification.accountsChecked.length > 0 && verification.matchingPosts.length === 0) {
      return res.status(409).json({
        message: 'No live Meta/Instagram post was detected after this video was downloaded. Post it first, then tap Mark Posted again.',
        verification: {
          manualDownloadedAt: post.manualDownloadedAt,
          checkedFrom: verificationStart,
          accountsChecked: verification.accountsChecked,
          syncedCount: verification.syncedPosts.length,
          errors: verification.errors,
        },
      });
    }

    await removePostFromQueue(post._id);
    post.status = 'posted_manual';
    post.publishSource = 'creator';
    post.manualPostedAt = new Date();
    post.manualPostUrl = manualPostUrl;
    post.postedByUserId = req.user._id;
    await post.save();

    res.status(200).json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Return a hybrid post back to automatic publishing
// @route   POST /api/scheduler/:id/return-to-auto
// @access  Private (Owner, Admin, Editor)
router.post('/:id/return-to-auto', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const post = mockStore.scheduledPosts.find(p => p._id === id);
      if (!post) return res.status(404).json({ message: 'Post not found' });
      post.scheduleMode = 'hybrid';
      post.status = 'scheduled';
      post.publishSource = null;
      post.manualPostedAt = null;
      post.manualPostUrl = '';
      post.postedByUserId = null;
      post.updatedAt = new Date();
      return res.status(200).json(post);
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const post = await ScheduledPost.findOne({ _id: id, campaignId });
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (post.scheduleMode !== 'hybrid') {
      return res.status(400).json({ message: 'Only hybrid posts can be returned to automatic publishing.' });
    }

    post.status = 'scheduled';
    post.publishSource = null;
    post.manualPostedAt = null;
    post.manualPostUrl = '';
    post.postedByUserId = null;
    await post.save();
    await removePostFromQueue(post._id);
    await addPostToQueue(post);

    const populated = await ScheduledPost.findOne({ _id: id, campaignId })
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds');
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Update/Reschedule a post (supports Drag & Drop)
// @route   PUT /api/scheduler/:id
// @access  Private (Owner, Admin, Editor)
router.put('/:id', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;
  const { scheduledAt, caption, mediaIds, socialAccountIds, platformSpecifics, status } = req.body;
  const nextScheduleMode = req.body.scheduleMode === undefined ? null : normalizeScheduleMode(req.body.scheduleMode);

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;

    if (!isConnected) {
      const post = mockStore.scheduledPosts.find(p => p._id === id);
      if (!post) {
        return res.status(404).json({ message: 'Post not found' });
      }

      if (scheduledAt) post.scheduledAt = new Date(scheduledAt);
      if (caption !== undefined) post.caption = caption;
      if (mediaIds) post.mediaIds = mediaIds;
      if (socialAccountIds) post.socialAccountIds = socialAccountIds;
      if (platformSpecifics) post.platformSpecifics = platformSpecifics;
      if (nextScheduleMode) post.scheduleMode = nextScheduleMode;
      if (status) post.status = status;
      if (nextScheduleMode && !status) post.status = getInitialStatusForMode(nextScheduleMode);
      post.updatedAt = new Date();

      return res.status(200).json(post);
    }

    const post = await ScheduledPost.findOne({ _id: id, campaignId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    if (mediaIds || socialAccountIds) {
      const access = await validateSchedulingAccess({
        campaignId,
        socialAccountIds: socialAccountIds || post.socialAccountIds,
        mediaIds: mediaIds || post.mediaIds,
        requireEveryAccount: true,
      });
      if (!access.ok) {
        return res.status(400).json({ message: access.message });
      }
    }

    if (scheduledAt) post.scheduledAt = new Date(scheduledAt);
    if (caption !== undefined) post.caption = caption;
    if (mediaIds) post.mediaIds = mediaIds;
    if (socialAccountIds) post.socialAccountIds = socialAccountIds;
    if (platformSpecifics) post.platformSpecifics = platformSpecifics;
    if (nextScheduleMode) post.scheduleMode = nextScheduleMode;
    if (status) post.status = status;
    if (nextScheduleMode && !status) post.status = getInitialStatusForMode(nextScheduleMode);
    
    await post.save();

    await removePostFromQueue(post._id);
    if (shouldQueuePost(post)) {
      await addPostToQueue(post);
    }
    
    const populated = await ScheduledPost.findOne({ _id: id, campaignId })
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds');
      
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete/cancel active schedule queue for one account
// @route   DELETE /api/scheduler/queue/account/:accountId
// @access  Private (Owner, Admin, Editor)
router.delete('/queue/account/:accountId', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { accountId } = req.params;

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;

    if (!isConnected) {
      const beforeCount = mockStore.scheduledPosts.length;
      const shouldDelete = (post) => (
        activeQueueStatuses.includes(post.status)
        && idsToStrings(post.socialAccountIds).includes(String(accountId))
      );
      mockStore.scheduledPosts = mockStore.scheduledPosts.filter((post) => !shouldDelete(post));
      return res.status(200).json({
        message: 'Account schedule queue removed successfully',
        deletedCount: beforeCount - mockStore.scheduledPosts.length,
      });
    }

    const query = {
      campaignId,
      status: { $in: activeQueueStatuses },
      socialAccountIds: accountId,
    };

    const posts = await ScheduledPost.find(query).select('_id socialAccountIds');
    let deletedCount = 0;

    for (const post of posts) {
      const accountIds = idsToStrings(post.socialAccountIds);
      if (accountIds.length > 1) {
        post.socialAccountIds = post.socialAccountIds.filter((id) => String(id) !== String(accountId));
        await post.save();
      } else {
        await removePostFromQueue(post._id);
        await ScheduledPost.deleteOne({ _id: post._id, campaignId });
        deletedCount += 1;
      }
    }

    res.status(200).json({
      message: 'Account schedule queue removed successfully',
      deletedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete/Cancel a scheduled post
// @route   DELETE /api/scheduler/:id
// @access  Private (Owner, Admin, Editor)
router.delete('/:id', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;

    if (!isConnected) {
      const index = mockStore.scheduledPosts.findIndex(p => p._id === id);
      if (index === -1) {
        return res.status(404).json({ message: 'Post not found' });
      }
      mockStore.scheduledPosts.splice(index, 1);
      return res.status(200).json({ message: 'Scheduled post removed successfully' });
    }

    const post = await ScheduledPost.findOne({ _id: id, campaignId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    await removePostFromQueue(post._id);
    await ScheduledPost.deleteOne({ _id: id, campaignId });
    res.status(200).json({ message: 'Scheduled post removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get today's live-post tracking for verified creator accounts
router.get('/creator/today-tracking', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(200).json({ accounts: {} });
    }

    const now = new Date();
    const defaultStart = new Date(now);
    defaultStart.setHours(0, 0, 0, 0);
    const defaultEnd = new Date(now);
    defaultEnd.setHours(23, 59, 59, 999);
    const from = getDateBoundary(req.query.from, defaultStart);
    const to = getDateBoundary(req.query.to, defaultEnd);

    const handlerEmail = (req.user.email || '').trim().toLowerCase();
    console.log('[today-tracking] request date window', {
      userId: String(req.user._id || ''),
      email: handlerEmail,
      query: req.query,
      serverTimezoneOffsetMinutes: now.getTimezoneOffset(),
      serverNow: toDebugDate(now),
      defaultStart: toDebugDate(defaultStart),
      defaultEnd: toDebugDate(defaultEnd),
      from: toDebugDate(from),
      to: toDebugDate(to),
    });

    const creatorAccounts = await SocialAccount.find({
      userId: req.user._id,
      isConnected: true,
    }).select('_id platform username name accountId').lean();
    const accountLookupPairs = creatorAccounts.flatMap((account) => (
      getAccountMatchHandles(account).map((handle) => ({
        platform: account.platform,
        handle,
      }))
    ));
    const creatorAccountIds = creatorAccounts.map((account) => account._id);
    const assignedChannels = await CampaignChannel.find({
      $or: [
        { assignedHandlerUserId: req.user._id },
        ...(handlerEmail ? [{ assignedHandlerEmail: handlerEmail }] : []),
        { socialAccountId: { $in: creatorAccountIds } },
        ...accountLookupPairs.map(({ platform, handle }) => ({
          platform,
          normalizedHandle: handle,
        })),
      ],
    }).select('socialAccountId status').lean();
    console.log('[today-tracking] matched creator accounts/channels', {
      creatorAccounts: creatorAccounts.map((account) => ({
        _id: String(account._id || ''),
        platform: account.platform || '',
        username: account.username || '',
        name: account.name || '',
        accountId: account.accountId || '',
      })),
      accountLookupPairs,
      assignedChannels: assignedChannels.map((channel) => ({
        _id: String(channel._id || ''),
        socialAccountId: String(channel.socialAccountId || ''),
        status: channel.status || '',
      })),
    });

    const accountIds = [
      ...new Set([
        ...creatorAccountIds.map((accountId) => String(accountId)),
        ...assignedChannels
          .map((channel) => channel.socialAccountId)
          .filter(Boolean)
          .map((accountId) => String(accountId)),
      ]),
    ];

    if (accountIds.length === 0) {
      console.log('[today-tracking] no account ids resolved', {
        userId: String(req.user._id || ''),
        email: handlerEmail,
      });
      return res.status(200).json({ accounts: {} });
    }

    const publishedPostQuery = {
      accountId: { $in: accountIds },
      publishedAt: { $gte: from, $lte: to },
    };
    console.log('[today-tracking] PublishedPost query', {
      accountIds,
      publishedAt: {
        $gte: toDebugDate(from),
        $lte: toDebugDate(to),
      },
    });

    const posts = await PublishedPost.find({
      accountId: { $in: accountIds },
      publishedAt: { $gte: from, $lte: to },
    })
      .select('accountId metaPostId platform content mediaUrl videoUrl mediaType facebookVideoId permalink publishedAt lastSyncedAt')
      .sort({ publishedAt: -1 })
      .lean();

    const postsByPlatform = posts.reduce((summary, post) => {
      const platform = post.platform || 'unknown';
      if (!summary[platform]) summary[platform] = [];
      summary[platform].push(summarizeTodayTrackingPost(post));
      return summary;
    }, {});
    console.log('[today-tracking] PublishedPost results', {
      query: publishedPostQuery,
      total: posts.length,
      byPlatformCounts: Object.fromEntries(
        Object.entries(postsByPlatform).map(([platform, platformPosts]) => [platform, platformPosts.length]),
      ),
      instagramVideos: posts
        .filter((post) => post.platform === 'instagram')
        .map(summarizeTodayTrackingPost),
      metaVideos: posts
        .filter((post) => ['facebook', 'instagram'].includes(post.platform))
        .map(summarizeTodayTrackingPost),
      allPosts: posts.map(summarizeTodayTrackingPost),
    });

    const accounts = posts.reduce((summary, post) => {
      const accountId = String(post.accountId);
      if (!summary[accountId]) {
        summary[accountId] = {
          count: 0,
          lastPublishedAt: null,
          posts: [],
        };
      }

      summary[accountId].count += 1;
      if (!summary[accountId].lastPublishedAt) {
        summary[accountId].lastPublishedAt = post.publishedAt;
      }
      summary[accountId].posts.push({
        id: post.metaPostId,
        platform: post.platform,
        content: post.content || '',
        permalink: post.permalink || '',
        publishedAt: post.publishedAt,
        lastSyncedAt: post.lastSyncedAt,
      });
      return summary;
    }, {});

    res.status(200).json({ accounts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get all scheduled posts assigned to this creator's accounts
router.get('/creator/posts', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(200).json([]);
    }

    // 1. Find social accounts and manual channel assignments controlled by this handler
    const creatorAccounts = await SocialAccount.find({ userId: req.user._id }).select('_id').lean();
    const creatorAccountIds = creatorAccounts.map(acc => acc._id);
    const creatorAccountIdSet = new Set(creatorAccountIds.map((id) => String(id)));
    const handlerEmail = (req.user.email || '').trim().toLowerCase();
    const assignedChannels = await CampaignChannel.find({
      $or: [
        { assignedHandlerUserId: req.user._id },
        ...(handlerEmail ? [{ assignedHandlerEmail: handlerEmail }] : []),
      ],
    }).select('_id').lean();
    const assignedChannelIds = assignedChannels.map((channel) => channel._id);
    const assignedChannelIdSet = new Set(assignedChannelIds.map((id) => String(id)));

    if (creatorAccountIds.length === 0 && assignedChannelIds.length === 0) {
      return res.status(200).json([]);
    }

    // 2. Find scheduled posts containing these accounts/channels, but only expose this handler's targets
    const posts = await ScheduledPost.find({
      $or: [
        { socialAccountIds: { $in: creatorAccountIds } },
        { campaignChannelIds: { $in: assignedChannelIds } },
      ],
    })
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds')
      .sort({ scheduledAt: 1 })
      .lean();

    res.status(200).json(posts.map((post) => ({
      ...post,
      socialAccountIds: (post.socialAccountIds || []).filter((account) => (
        creatorAccountIdSet.has(String(account?._id || account))
      )),
      campaignChannelIds: (post.campaignChannelIds || []).filter((channel) => (
        assignedChannelIdSet.has(String(channel?._id || channel))
      )),
    })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
