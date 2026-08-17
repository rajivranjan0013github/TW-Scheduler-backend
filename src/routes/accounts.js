import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import SocialAccount from '../models/SocialAccount.js';
import Campaign from '../models/Campaign.js';
import Insight from '../models/Insight.js';
import PublishedPost from '../models/PublishedPost.js';
import PostInsight from '../models/PostInsight.js';
import { recordStoredMetricSnapshots } from '../queues/metricSyncWorker.js';
import { protect, authorize, resolveHandlerPreview } from '../middleware/auth.js';
import { getYoutubeAuthUrl, exchangeYoutubeCodeForAccount, fetchYoutubeVideos } from '../services/youtubeService.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from '../services/tokenHealthService.js';
import {
  fetchFacebookPostEngagement,
  fetchFacebookPostInsightValue,
  fetchFacebookPostViews,
} from '../services/facebookMetricsService.js';
import { storeRemoteSocialAccountAvatar } from '../services/avatarStorageService.js';
import {
  canAccountVerifyCampaign,
  linkSocialAccountToCampaignChannels,
  normalizeChannelHandle,
  resolveCampaignPublishingChannels,
} from '../utils/campaignChannels.js';
import CampaignChannel from '../models/CampaignChannel.js';
import MetricSyncStatus from '../models/MetricSyncStatus.js';
import { requestAccountSync } from '../queues/publisherQueue.js';

const router = express.Router();
const insightSkipCache = new Map();

const serializeCommentsPreview = (comments = []) => (
  comments.map((comment) => ({
    id: comment.id || '',
    username: comment.username || comment.from?.name || '',
    text: comment.text || comment.message || '',
    timestamp: comment.timestamp || comment.created_time || null,
  })).filter(comment => comment.text).slice(0, 3)
);

const serializeCachedPublishedPost = (post) => ({
  id: post.metaPostId,
  content: post.content,
  createdAt: post.publishedAt,
  permalink: post.permalink,
  mediaUrl: post.mediaUrl,
  videoUrl: post.videoUrl,
  mediaType: post.mediaType,
  facebookVideoId: post.facebookVideoId || '',
  viewsSource: post.viewsSource || '',
  views: post.viewsSource === 'unavailable' ? null : (post.latestViews || 0),
  likes: post.latestLikes || 0,
  comments: post.latestComments || 0,
  commentsPreview: serializeCommentsPreview(post.commentsPreview || []),
  lastSyncedAt: post.lastSyncedAt,
  hasFreshViews: post.viewsSource !== 'unavailable',
});

const INSIGHT_SKIP_MS = 15 * 60 * 1000;
const ADMIN_ROLES = ['owner', 'admin'];
const MAX_FEED_SYNC_PAGES = 20;
const PUBLISHED_FEED_WINDOW_DAYS = 30;
const LIVE_METRIC_POST_LIMIT = 30;
const LIVE_METRIC_CONCURRENCY = 3;
const hasAdminAccess = (user) => ADMIN_ROLES.includes(user?.role) && user?.userType !== 'account_handler';

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

const fetchMetaPagedData = async (initialUrl, { maxPages = MAX_FEED_SYNC_PAGES, shouldStop = null } = {}) => {
  const items = [];
  let url = initialUrl;
  let page = 0;

  while (url && page < maxPages) {
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data,
        items,
      };
    }

    const pageItems = data.data || [];
    items.push(...pageItems);
    if (typeof shouldStop === 'function' && shouldStop(pageItems)) {
      break;
    }
    url = data.paging?.next || '';
    page += 1;
  }

  return {
    ok: true,
    status: 200,
    data: { data: items },
    items,
  };
};

const getAccountMatchHandles = (account = {}) => (
  [
    normalizeChannelHandle(account.username),
    normalizeChannelHandle(account.name),
    normalizeChannelHandle(account.accountId),
  ].filter(Boolean)
);

const getAccountAccessFilter = (req, id) => {
  if (hasAdminAccess(req.user)) {
    return { _id: id };
  }
  return { _id: id, userId: req.user._id };
};

const getReauthorizationAccount = async (req, accountId, platform, campaignId) => {
  if (!accountId) return null;

  const account = await SocialAccount.findById(accountId);
  if (!account || account.platform !== platform) {
    const error = new Error('The channel selected for reauthorization was not found.');
    error.statusCode = 404;
    throw error;
  }

  const isOwner = String(account.userId) === String(req.user._id);
  let isAssignedHandler = false;
  if (!isOwner && !hasAdminAccess(req.user) && campaignId) {
    const userEmail = String(req.user.email || '').trim().toLowerCase();
    isAssignedHandler = Boolean(await CampaignChannel.exists({
      campaignId,
      platform,
      $or: [
        { socialAccountId: account._id },
        { assignedHandlerUserId: req.user._id },
        ...(userEmail ? [{ assignedHandlerEmail: userEmail }] : []),
      ],
    }));
  }

  if (!isOwner && !hasAdminAccess(req.user) && !isAssignedHandler) {
    const error = new Error('You cannot reauthorize this channel.');
    error.statusCode = 403;
    throw error;
  }

  return account;
};

const providerAccountMatches = (existingAccount, accountPayload) => {
  if (!existingAccount || existingAccount.platform !== accountPayload?.platform) return false;
  if (String(existingAccount.accountId) === String(accountPayload.accountId)) return true;

  const existingHandles = new Set(getAccountMatchHandles(existingAccount));
  return getAccountMatchHandles(accountPayload).some((handle) => existingHandles.has(handle));
};

const saveConnectedAccount = async ({ reauthorizationAccount, filter, payload }) => {
  if (reauthorizationAccount) {
    return SocialAccount.findByIdAndUpdate(
      reauthorizationAccount._id,
      {
        ...payload,
        userId: reauthorizationAccount.userId,
      },
      { returnDocument: 'after', runValidators: true }
    );
  }

  return SocialAccount.findOneAndUpdate(
    filter,
    payload,
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
  );
};

const getScopedUserId = (req) => {
  if (hasAdminAccess(req.user) && req.query.userId) {
    return req.query.userId;
  }
  return req.user._id;
};

const getActiveCampaignId = (req) => req.query.campaignId || req.body?.campaignId || null;

const getVerifiedCampaignSocialAccountIds = async (campaignId) => {
  const channels = await CampaignChannel.find({
    campaignId,
    status: 'verified',
    socialAccountId: { $ne: null },
  }).select('socialAccountId').lean();
  return channels.map((channel) => channel.socialAccountId);
};

const canAccessCampaign = async (req, campaignId) => {
  if (!campaignId) return false;
  if (hasAdminAccess(req.user)) return true;

  const userEmail = (req.user.email || '').trim().toLowerCase();
  const campaign = await Campaign.findOne({
    _id: campaignId,
    status: { $ne: 'archived' },
    $or: [
      { mainEmail: userEmail },
      { mainEmail: { $in: ['', null] }, createdBy: req.user._id },
      { createdBy: req.user._id },
    ],
  }).select('_id').lean();

  if (campaign) return true;

  const assignedChannel = await CampaignChannel.exists({
    campaignId,
    $or: [
      { assignedHandlerUserId: req.user._id },
      ...(userEmail ? [{ assignedHandlerEmail: userEmail }] : []),
    ],
  });
  if (assignedChannel) return true;

  const userAccounts = await SocialAccount.find({ userId: req.user._id, isConnected: true })
    .select('platform username name accountId')
    .lean();
  if (userAccounts.length === 0) return false;

  const campaignChannels = await CampaignChannel.find({ campaignId }).select('platform normalizedHandle').lean();
  return campaignChannels.some((channel) => (
    userAccounts.some((account) => (
      account.platform === channel.platform &&
      [
        normalizeChannelHandle(account.username),
        normalizeChannelHandle(account.name),
        normalizeChannelHandle(account.accountId),
      ].includes(channel.normalizedHandle)
    ))
  ));
};

const getScopedAccountQuery = async (req, extra = {}) => {
  const campaignId = getActiveCampaignId(req);
  if (campaignId) {
    const allowed = await canAccessCampaign(req, campaignId);
    if (!allowed) {
      const error = new Error('Campaign access denied.');
      error.statusCode = 403;
      throw error;
    }

    return { campaignId, ...extra };
  }

  return { userId: getScopedUserId(req), ...extra };
};

const getLinkableCampaignId = async (req, campaignId, accountPayload) => {
  if (!campaignId) return undefined;
  if (hasAdminAccess(req.user)) return campaignId;
  return await canAccountVerifyCampaign(campaignId, accountPayload) ? campaignId : undefined;
};

const linkAccountToCampaign = async (campaignId, socialAccountId, platform, username, name, accountId, userId = null, userEmail = '') => {
  if (!campaignId || !socialAccountId) return;
  try {
    await linkSocialAccountToCampaignChannels(campaignId, {
      _id: socialAccountId,
      platform,
      username,
      name,
      accountId,
      isConnected: true,
      userId,
      userEmail,
    });
  } catch (err) {
    console.error('Failed to link account to campaign:', err.message);
  }
};

// @desc    Get all connected accounts
// @route   GET /api/accounts
// @access  Private
router.get('/', protect, resolveHandlerPreview, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const campaignId = getActiveCampaignId(req);
    if (campaignId) {
      const allowed = await canAccessCampaign(req, campaignId);
      if (!allowed) {
        return res.status(403).json({ message: 'Campaign access denied.' });
      }

      const accountIds = await getVerifiedCampaignSocialAccountIds(campaignId);
      let query = { _id: { $in: accountIds }, isConnected: true };
      if (req.user?.userType === 'account_handler') {
        query.userId = req.user._id;
      }
      const accounts = accountIds.length > 0
        ? await SocialAccount.find(query)
        : [];
      return res.status(200).json(accounts);
    }

    const accounts = await SocialAccount.find(await getScopedAccountQuery(req));
    res.status(200).json(accounts);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

// @desc    Get campaign publishing channels, including pending verification rows
// @route   GET /api/accounts/publishing-channels?campaignId=...
// @access  Private
router.get('/publishing-channels', protect, resolveHandlerPreview, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const campaignId = getActiveCampaignId(req);
    if (!campaignId) {
      return res.status(400).json({ message: 'Campaign is required.' });
    }

    const allowed = await canAccessCampaign(req, campaignId);
    if (!allowed) {
      return res.status(403).json({ message: 'Campaign access denied.' });
    }

    const campaign = await Campaign.findById(campaignId).select('channels status').lean();
    if (!campaign || campaign.status === 'archived') {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    if (req.user?.userType === 'account_handler') {
      const handlerEmail = (req.user.email || '').trim().toLowerCase();
      const creatorAccounts = await SocialAccount.find({ userId: req.user._id }).lean();
      const creatorAccountIds = creatorAccounts.map((account) => account._id);
      const creatorAccountsById = new Map(
        creatorAccounts.map((account) => [String(account._id), account])
      );
      const accountLookupPairs = creatorAccounts.flatMap((account) => (
        getAccountMatchHandles(account).map((handle) => ({
          platform: account.platform,
          handle,
        }))
      ));
      const channelConditions = [
        { assignedHandlerUserId: req.user._id },
        ...(handlerEmail ? [{ assignedHandlerEmail: handlerEmail }] : []),
        { socialAccountId: { $in: creatorAccountIds } },
        ...accountLookupPairs.map(({ platform, handle }) => ({
          platform,
          normalizedHandle: handle,
        })),
      ];

      const creatorChannels = await CampaignChannel.find({
        campaignId,
        $or: channelConditions,
      }).sort({ createdAt: 1 }).lean();

      const channels = creatorChannels
        .map((channel) => {
          const linkedAccountId = channel.socialAccountId ? String(channel.socialAccountId) : '';
          const linkedCreatorAccount = linkedAccountId
            ? creatorAccountsById.get(linkedAccountId)
            : null;
          const normalizedHandle = channel.normalizedHandle || normalizeChannelHandle(channel.requestedHandle);
          const matchedAcc = linkedCreatorAccount || creatorAccounts.find((account) => (
            account.platform === channel.platform &&
            getAccountMatchHandles(account).includes(normalizedHandle)
          ));
          const isAssignedToHandler = Boolean(
            String(channel.assignedHandlerUserId || '') === String(req.user._id)
            || (handlerEmail && channel.assignedHandlerEmail === handlerEmail)
          );
          if (!matchedAcc && !isAssignedToHandler) return null;

          const isVerified = Boolean(matchedAcc && matchedAcc.isConnected !== false);
          return {
            _id: channel._id,
            platform: channel.platform,
            handle: channel.requestedHandle,
            requestedHandle: channel.requestedHandle,
            displayName: channel.displayName || '',
            addedAt: channel.createdAt,
            // Keep the expired account id available so the OAuth callback can
            // refresh this exact record instead of creating another one.
            socialAccountId: matchedAcc?._id || channel.socialAccountId || null,
            accountId: matchedAcc?.accountId || '',
            name: matchedAcc?.name || channel.displayName || channel.requestedHandle,
            username: matchedAcc?.username || normalizedHandle,
            avatarUrl: matchedAcc?.avatarUrl || null,
            isConnected: isVerified,
            isVerified,
            status: isVerified ? 'verified' : isAssignedToHandler ? 'manual_only' : 'disconnected',
            matchedAccountId: matchedAcc?._id || null,
            userId: matchedAcc?.userId || channel.assignedHandlerUserId || null,
            assignedHandlerEmail: channel.assignedHandlerEmail || '',
            assignedHandlerUserId: channel.assignedHandlerUserId || null,
            campaignId,
            tokenExpiresAt: matchedAcc?.tokenExpiresAt || null,
            tokenStatus: matchedAcc?.tokenStatus || 'unknown',
            analyticsStatus: matchedAcc?.analyticsStatus || 'unknown',
            analyticsError: matchedAcc?.analyticsError || '',
            verifiedAt: isVerified ? (matchedAcc.updatedAt || matchedAcc.createdAt || null) : null,
            verifiedByUserId: isVerified ? matchedAcc.userId : null,
          };
        })
        .filter(Boolean);

      return res.status(200).json(channels);
    }

    const channels = await resolveCampaignPublishingChannels(campaign, { persist: true });
    res.status(200).json(channels);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

// @desc    Get campaign workspaces visible to the signed-in user's email
// @route   GET /api/accounts/campaigns
// @access  Private
router.get('/campaigns', protect, resolveHandlerPreview, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const userEmail = (req.user.email || '').trim().toLowerCase();
    const campaigns = await Campaign.find({
      status: { $ne: 'archived' },
      $or: [
        { mainEmail: userEmail },
        { mainEmail: { $in: ['', null] }, createdBy: req.user._id },
      ],
    })
      .populate('createdBy', 'name email')
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json(campaigns);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create a campaign workspace for the signed-in user
// @route   POST /api/accounts/campaigns
// @access  Private
router.post('/campaigns', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const {
      name,
      description = '',
      productName = '',
      productWebsite = '',
      targetAudience = '',
      primaryGoal = '',
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ message: 'Campaign name is required.' });
    }

    const campaign = await Campaign.create({
      name: name.trim(),
      description,
      productName,
      productWebsite,
      targetAudience,
      primaryGoal,
      mainEmail: (req.user.email || '').trim().toLowerCase(),
      status: 'active',
      accountIds: [],
      createdBy: req.user._id,
    });

    const populated = await Campaign.findById(campaign._id)
      .populate('createdBy', 'name email')
      .lean();

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get aggregated insights for all connected channels
// @route   GET /api/accounts/insights
// @access  Private
router.get('/insights', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Insights service is unavailable.' });
    }

    const campaignId = getActiveCampaignId(req);
    let accounts;
    if (campaignId) {
      const allowed = await canAccessCampaign(req, campaignId);
      if (!allowed) {
        return res.status(403).json({ message: 'Campaign access denied.' });
      }
      const accountIds = await getVerifiedCampaignSocialAccountIds(campaignId);
      let query = { _id: { $in: accountIds }, isConnected: true };
      if (req.user?.userType === 'account_handler') {
        query.userId = req.user._id;
      }
      accounts = accountIds.length > 0
        ? await SocialAccount.find(query)
        : [];
    } else {
      accounts = await SocialAccount.find(await getScopedAccountQuery(req, { isConnected: true }));
    }
    if (accounts.length === 0) {
      return res.status(200).json([]);
    }

    const period = req.query.period || '7d';
    const forceRefresh = req.query.refresh === 'true';
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    let daysCount = 7;
    let sinceDate = new Date();

    if (period === '30d') {
      daysCount = 30;
      sinceDate.setDate(today.getDate() - 30);
    } else if (period === 'this_month') {
      daysCount = today.getDate();
      sinceDate = new Date(today.getFullYear(), today.getMonth(), 1);
    } else {
      daysCount = 7;
      sinceDate.setDate(today.getDate() - 7);
    }

    // List of date strings in the timeframe range
    const dateStrings = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const chartMap = {};

    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      dateStrings.push(dateStr);

      let dayNameLabel = '';
      if (period === 'this_month' || period === '30d') {
        dayNameLabel = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      } else {
        dayNameLabel = dayNames[d.getDay()];
      }

      chartMap[dateStr] = {
        name: dayNameLabel,
        Instagram: 0,
        Facebook: 0
      };
    }

    const fetchDailyInsightValues = async (account, metricCandidates, sinceTime, untilTime) => {
      const invalidMetrics = [];
      const graphHost = account.authProvider === 'instagram'
        ? 'graph.instagram.com'
        : 'graph.facebook.com';

      for (const metric of metricCandidates) {
        const url = `https://${graphHost}/v20.0/${account.accountId}/insights?metric=${metric}&period=day&since=${sinceTime}&until=${untilTime}&access_token=${account.accessToken}`;
        const apiRes = await fetch(url);
        const apiData = await apiRes.json();

        if (apiRes.ok) {
          return apiData.data?.[0]?.values || [];
        }

        const message = apiData.error?.message || 'Meta API returned an error';
        const isInvalidMetric = apiData.error?.code === 100 && message.toLowerCase().includes('valid insights metric');

        if (!isInvalidMetric) {
          throw new Error(message);
        }

        invalidMetrics.push(metric);
      }

      throw new Error(`No supported Meta insights metric was available for this channel. Tried: ${invalidMetrics.join(', ')}`);
    };

    // Loop through each account and fetch/caching details
    for (const account of accounts) {
      if (!['instagram', 'facebook'].includes(account.platform)) {
        continue;
      }

      const isMock = account.accessToken?.startsWith('mock-');
      let liveAccount = account;
      const skipUntil = insightSkipCache.get(account._id.toString());
      if (skipUntil && skipUntil > Date.now()) {
        continue;
      }

      // Check DB Cache for dates in timeframe range (including today)
      let cachedInsights = [];
      
      if (!forceRefresh) {
        try {
          cachedInsights = await Insight.find({ accountId: account._id, dateStr: { $in: dateStrings } });
        } catch (err) {
          console.error('Failed to query Insight cache:', err.message);
        }
      }

      const cachedDatesMap = {};
      for (const item of cachedInsights) {
        cachedDatesMap[item.dateStr] = item.value;
      }

      // Identify missing dates to query from Meta/Mock
      // If forceRefresh is active, query all dates live. Otherwise, query only missing dates.
      const missingDates = forceRefresh ? dateStrings : dateStrings.filter(d => cachedDatesMap[d] === undefined);

      const fetchAndCacheRange = async (targetDates) => {
        if (targetDates.length === 0) return {};
        
        const results = {};
        
        if (isMock) {
          // Mock curve seed logic based on date value
          let seed = account.platform === 'instagram' ? 3200 : 2100;
          targetDates.forEach(dateStr => {
            const timeVal = new Date(dateStr).getTime() / (1000 * 60 * 60 * 24);
            const randomVal = Math.floor(seed + Math.sin(timeVal * 0.8) * 1100 + (timeVal % 7) * 100);
            results[dateStr] = randomVal;
          });
        } else {
          try {
            liveAccount = await ensureFreshAccountToken(liveAccount);
          } catch (authErr) {
            await handleProviderAuthFailure(liveAccount, authErr, authErr.message);
            throw authErr;
          }

          // Real Meta API query range
          const datesSorted = [...targetDates].sort();
          const targetSinceDate = new Date(datesSorted[0]);
          const targetUntilDate = new Date(datesSorted[datesSorted.length - 1]);
          targetUntilDate.setDate(targetUntilDate.getDate() + 1);

          const targetSince = Math.floor(targetSinceDate.getTime() / 1000);
          const targetUntil = Math.floor(targetUntilDate.getTime() / 1000);

          try {
            const metric = liveAccount.platform === 'facebook' ? 'page_post_engagements' : 'reach';
            const apiValues = await fetchDailyInsightValues(liveAccount, [metric], targetSince, targetUntil);
            
            for (const item of apiValues) {
              const dateStr = item.end_time.split('T')[0];
              if (targetDates.includes(dateStr)) {
                results[dateStr] = item.value;
              }
            }
          } catch (apiErr) {
            await handleProviderAuthFailure(liveAccount, apiErr, apiErr.message);
            console.error(`Meta fetch failed for ${liveAccount.name}:`, apiErr.message);
          }
        }

        // Cache retrieved dates in MongoDB (including today's current count)
        const insertDocs = Object.keys(results).map(dateStr => ({
          campaignId: liveAccount.campaignId,
          accountId: liveAccount._id,
          dateStr,
          platform: liveAccount.platform,
          value: results[dateStr]
        }));

        for (const doc of insertDocs) {
          try {
            await Insight.findOneAndUpdate(
              { accountId: doc.accountId, dateStr: doc.dateStr },
              doc,
              { upsert: true, returnDocument: 'after' }
            );
          } catch (dbErr) {
            console.error('Failed to cache insight in database:', dbErr.message);
          }
        }

        return results;
      };

      // Query Meta/Mock for missing dates
      let newCachedData = {};
      if (missingDates.length > 0) {
        newCachedData = await fetchAndCacheRange(missingDates);
      }

      // Populate chartMap
      for (const dateStr of dateStrings) {
        const val = cachedDatesMap[dateStr] !== undefined 
          ? cachedDatesMap[dateStr] 
          : (newCachedData[dateStr] || 0);

        if (liveAccount.platform === 'instagram') {
          chartMap[dateStr].Instagram += val;
        } else {
          chartMap[dateStr].Facebook += val;
        }
      }
    }

    // Convert map to sorted array
    const result = Object.keys(chartMap)
      .sort()
      .map(dateStr => chartMap[dateStr]);

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Connect a new account
// @route   POST /api/accounts/connect
// @access  Private (Owner, Admin)
router.post('/connect', protect, resolveHandlerPreview, async (req, res) => {
  const { platform, accountId, name, username, accessToken, avatarUrl, campaignId } = req.body;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const linkableCampaignId = await getLinkableCampaignId(req, campaignId, {
      platform,
      accountId,
      name,
      username,
    });
    const storedAvatarUrl = await storeRemoteSocialAccountAvatar({
      platform,
      accountId,
      avatarUrl,
    });

    let account = await SocialAccount.findOne({ userId: req.user._id, accountId });
    if (account) {
      account.isConnected = true;
      account.accessToken = accessToken || 'mock-access-token';
      if (storedAvatarUrl) account.avatarUrl = storedAvatarUrl;
      account.campaignId = linkableCampaignId || undefined;
      account.tokenStatus = 'healthy';
      account.tokenRefreshError = '';
      account.tokenLastCheckedAt = new Date();
      await account.save();
    } else {
      account = await SocialAccount.create({
        userId: req.user._id,
        campaignId: linkableCampaignId || undefined,
        platform,
        accountId,
        name,
        username,
        accessToken: accessToken || 'mock-access-token',
        avatarUrl: storedAvatarUrl,
        tokenStatus: 'healthy',
        tokenLastCheckedAt: new Date(),
      });
    }

    if (linkableCampaignId) {
      await linkAccountToCampaign(linkableCampaignId, account._id, platform, username, name, accountId, req.user._id, req.user.email || '');
    }

    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get YouTube OAuth URL
// @route   GET /api/accounts/youtube/auth-url
// @access  Private (Owner, Admin)
router.get('/youtube/auth-url', protect, resolveHandlerPreview, async (req, res) => {
  try {
    const url = getYoutubeAuthUrl();
    res.status(200).json({ url });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Callback from YouTube OAuth to connect a channel
// @route   POST /api/accounts/youtube-callback
// @access  Private (Owner, Admin)
router.post('/youtube-callback', protect, resolveHandlerPreview, async (req, res) => {
  const { code, campaignId, reauthorizeAccountId } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Authorization code is required' });
  }

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. YouTube channel connection requires MongoDB.' });
    }

    const reauthorizationAccount = await getReauthorizationAccount(
      req,
      reauthorizeAccountId,
      'youtube',
      campaignId
    );
    const accountPayload = await exchangeYoutubeCodeForAccount(code, req.user._id);
    if (reauthorizationAccount && !providerAccountMatches(reauthorizationAccount, accountPayload)) {
      return res.status(409).json({
        message: `Please authorize the original YouTube channel "${reauthorizationAccount.name}".`,
      });
    }
    const linkableCampaignId = await getLinkableCampaignId(req, campaignId, accountPayload);
    if (campaignId && !linkableCampaignId && !hasAdminAccess(req.user)) {
      return res.status(403).json({ message: 'This YouTube channel does not match the campaign handle.' });
    }

    const account = await saveConnectedAccount({
      reauthorizationAccount,
      filter: {
        userId: req.user._id,
        platform: 'youtube',
        accountId: accountPayload.accountId,
      },
      payload: {
        ...accountPayload,
        campaignId: linkableCampaignId || reauthorizationAccount?.campaignId || undefined,
      },
    });

    if (linkableCampaignId) {
      await linkAccountToCampaign(linkableCampaignId, account._id, 'youtube', account.username, account.name, account.accountId, req.user._id, req.user.email || '');
    }

    res.status(200).json({
      message: `Successfully connected YouTube channel "${account.name}".`,
      account,
    });
  } catch (error) {
    console.error('❌ YouTube callback handler error:', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

// @desc    Disconnect an account
// @route   DELETE /api/accounts/:id
// @access  Private (Owner, Admin)
router.delete('/:id', protect, resolveHandlerPreview, async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const account = await SocialAccount.findOne(getAccountAccessFilter(req, id));
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    await SocialAccount.deleteOne(getAccountAccessFilter(req, id));
    res.status(200).json({ message: 'Account disconnected successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Callback from Facebook OAuth to connect accounts
// @route   POST /api/accounts/facebook-callback
// @access  Private (Owner, Admin)
router.post('/facebook-callback', protect, resolveHandlerPreview, async (req, res) => {
  const { code, campaignId, reauthorizeAccountId } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Authorization code is required' });
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI || 'https://theeasypost.com/auth/facebook/callback';

  if (!appId || !appSecret) {
    return res.status(500).json({ message: 'Meta App credentials are not configured on the backend.' });
  }

  try {
    const reauthorizationAccount = reauthorizeAccountId
      ? await SocialAccount.findById(reauthorizeAccountId)
      : null;
    if (reauthorizeAccountId && !reauthorizationAccount) {
      return res.status(404).json({ message: 'The channel selected for reauthorization was not found.' });
    }
    if (reauthorizationAccount && !['facebook', 'instagram'].includes(reauthorizationAccount.platform)) {
      return res.status(400).json({ message: 'This channel cannot be reauthorized with Meta.' });
    }
    if (reauthorizationAccount) {
      await getReauthorizationAccount(
        req,
        reauthorizeAccountId,
        reauthorizationAccount.platform,
        campaignId
      );
    }
    
    // 1. Exchange authorization code for short-lived user token
    const tokenExchangeUrl = `https://graph.facebook.com/v20.0/oauth/access_token` +
      `?client_id=${appId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&client_secret=${appSecret}` +
      `&code=${code}`;

    const exchangeRes = await fetch(tokenExchangeUrl);
    const exchangeData = await exchangeRes.json();

    if (!exchangeRes.ok) {
      console.error('❌ Meta Token Exchange Failed:', exchangeData);
      return res.status(400).json({ message: exchangeData.error?.message || 'Token exchange failed' });
    }

    const shortLivedToken = exchangeData.access_token;

    // 2. Upgrade to long-lived user token (60 days)
    const upgradeUrl = `https://graph.facebook.com/v20.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${appId}` +
      `&client_secret=${appSecret}` +
      `&fb_exchange_token=${shortLivedToken}`;

    const upgradeRes = await fetch(upgradeUrl);
    const upgradeData = await upgradeRes.json();

    if (!upgradeRes.ok) {
      console.error('❌ Meta Token Upgrade Failed:', upgradeData);
      return res.status(400).json({ message: upgradeData.error?.message || 'Token upgrade failed' });
    }

    const longLivedUserToken = upgradeData.access_token;

    // Debug the token permissions and gather target page IDs
    let targetPageIds = new Set();
    let grantedMetaScopes = [];
    let metaScopeInspectionAvailable = false;
    const pageTargetsByScope = new Map();
    try {
      const debugUrl = `https://graph.facebook.com/debug_token?input_token=${longLivedUserToken}&access_token=${appId}|${appSecret}`;
      const debugRes = await fetch(debugUrl);
      const debugData = await debugRes.json();
      
      grantedMetaScopes = Array.isArray(debugData?.data?.scopes)
        ? debugData.data.scopes
        : [];
      metaScopeInspectionAvailable = Array.isArray(debugData?.data?.scopes);
      if (debugData?.data?.granular_scopes) {
        for (const gs of debugData.data.granular_scopes) {
          if (gs.scope?.startsWith('pages_') && gs.target_ids) {
            pageTargetsByScope.set(gs.scope, new Set(gs.target_ids.map(String)));
            for (const tid of gs.target_ids) {
              targetPageIds.add(tid);
            }
          }
        }
      }
    } catch (debugErr) {
      console.error('❌ Failed to debug token:', debugErr.message);
    }

    // 3. Fetch user's Facebook Pages and Page Access Tokens
    const pagesUrl = `https://graph.facebook.com/v20.0/me/accounts?access_token=${longLivedUserToken}`;
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();

    if (!pagesRes.ok) {
      console.error('❌ Fetching Facebook Pages Failed:', pagesData);
      return res.status(400).json({ message: pagesData.error?.message || 'Failed to fetch Facebook Pages' });
    }

    let pagesList = pagesData.data || [];

    // Fallback: if pagesList is empty or missing targetPageIds, fetch them directly
    for (const pageId of targetPageIds) {
      if (!pagesList.some(p => p.id === pageId)) {
        try {
          const directPageUrl = `https://graph.facebook.com/v20.0/${pageId}?fields=name,username,access_token&access_token=${longLivedUserToken}`;
          const directPageRes = await fetch(directPageUrl);
          const directPageData = await directPageRes.json();
          if (directPageRes.ok && directPageData.access_token) {
            pagesList.push({
              id: pageId,
              name: directPageData.name,
              username: directPageData.username,
              access_token: directPageData.access_token
            });
          } else {
            console.warn(`⚠️ [Meta OAuth] Fallback: Failed to fetch Page ${pageId} directly:`, directPageData);
          }
        } catch (err) {
          console.error(`❌ [Meta OAuth] Fallback error for Page ${pageId}:`, err.message);
        }
      }
    }

    const connectedAccounts = [];
    let reauthorizationMatched = false;

    if (reauthorizationAccount?.platform === 'facebook') {
      pagesList = pagesList.filter((page) => providerAccountMatches(reauthorizationAccount, {
        platform: 'facebook',
        accountId: page.id,
        name: page.name,
        username: page.username,
      }));
    }

    // 4. Process each page and linked Instagram account
    for (const page of pagesList) {
      const pageAccessToken = page.access_token; // Permanent page-scoped token
      const pageId = page.id;
      const pageName = page.name;
      const pageUsername = page.username || pageName.toLowerCase().replace(/\s+/g, '');
      const requiredFacebookAnalyticsScopes = [
        'pages_read_engagement',
        'pages_read_user_content',
      ];
      const missingFacebookAnalyticsScopes = requiredFacebookAnalyticsScopes.filter((scope) => {
        if (!grantedMetaScopes.includes(scope)) return true;
        const targetIds = pageTargetsByScope.get(scope);
        return targetIds ? !targetIds.has(String(pageId)) : false;
      });
      const pageGrantedScopes = grantedMetaScopes.filter((scope) => {
        const targetIds = pageTargetsByScope.get(scope);
        return targetIds ? targetIds.has(String(pageId)) : true;
      });

      if (!reauthorizationAccount || reauthorizationAccount.platform === 'facebook') {
        // Get page avatar from metadata or fallback
        const pagePicUrl = `https://graph.facebook.com/v20.0/${pageId}/picture?type=normal&access_token=${pageAccessToken}`;
        const pageAvatarUrl = await storeRemoteSocialAccountAvatar({
          platform: 'facebook',
          accountId: pageId,
          avatarUrl: pagePicUrl,
        });

        const linkableCampaignId = await getLinkableCampaignId(req, campaignId, {
          platform: 'facebook',
          accountId: pageId,
          name: pageName,
          username: pageUsername,
        });

        const fbAccount = await saveConnectedAccount({
          reauthorizationAccount: reauthorizationAccount?.platform === 'facebook'
            ? reauthorizationAccount
            : null,
          filter: { userId: req.user._id, accountId: pageId },
          payload: {
            userId: reauthorizationAccount?.userId || req.user._id,
            campaignId: linkableCampaignId || reauthorizationAccount?.campaignId || undefined,
            platform: 'facebook',
            accountId: pageId,
            name: pageName,
            username: pageUsername,
            accessToken: pageAccessToken,
            authProvider: 'facebook',
            avatarUrl: pageAvatarUrl,
            isConnected: true,
            tokenStatus: 'healthy',
            tokenRefreshError: '',
            tokenLastCheckedAt: new Date(),
            scopes: pageGrantedScopes,
            analyticsStatus: !metaScopeInspectionAvailable
              ? 'unknown'
              : missingFacebookAnalyticsScopes.length > 0 ? 'permission_missing' : 'healthy',
            analyticsError: metaScopeInspectionAvailable && missingFacebookAnalyticsScopes.length > 0
              ? `Reconnect and grant: ${missingFacebookAnalyticsScopes.join(', ')}`
              : '',
            analyticsLastCheckedAt: new Date(),
          },
        });
        connectedAccounts.push(fbAccount);
        reauthorizationMatched = reauthorizationMatched || Boolean(reauthorizationAccount);
        if (linkableCampaignId) {
          await linkAccountToCampaign(linkableCampaignId, fbAccount._id, 'facebook', fbAccount.username, fbAccount.name, fbAccount.accountId, req.user._id, req.user.email || '');
        }
      }

      if (reauthorizationAccount?.platform === 'facebook') {
        continue;
      }

      // Find linked Instagram Business Account ID
      const igCheckUrl = `https://graph.facebook.com/v20.0/${pageId}?fields=instagram_business_account&access_token=${pageAccessToken}`;
      const igCheckRes = await fetch(igCheckUrl);
      const igCheckData = await igCheckRes.json();

      if (igCheckRes.ok && igCheckData.instagram_business_account) {
        const igAccountId = igCheckData.instagram_business_account.id;

        // Fetch Instagram Account details
        const igDetailUrl = `https://graph.facebook.com/v20.0/${igAccountId}?fields=name,username,profile_picture_url&access_token=${pageAccessToken}`;
        const igDetailRes = await fetch(igDetailUrl);
        const igDetailData = await igDetailRes.json();

        const igName = igDetailData.name || 'Instagram Account';
        const igUsername = igDetailData.username || 'instagram_account';
        const igAvatarUrl = igDetailData.profile_picture_url || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=150';
        const storedIgAvatarUrl = await storeRemoteSocialAccountAvatar({
          platform: 'instagram',
          accountId: igAccountId,
          avatarUrl: igAvatarUrl,
        });

        const instagramLinkableCampaignId = await getLinkableCampaignId(req, campaignId, {
          platform: 'instagram',
          accountId: igAccountId,
          name: igName,
          username: igUsername,
        });

        const instagramPayload = {
          platform: 'instagram',
          accountId: igAccountId,
          name: igName,
          username: igUsername,
        };
        if (reauthorizationAccount && !providerAccountMatches(reauthorizationAccount, instagramPayload)) {
          continue;
        }

        // Upsert Instagram Account in database
        const igAccount = await saveConnectedAccount({
          reauthorizationAccount,
          filter: { userId: req.user._id, accountId: igAccountId },
          payload: {
            userId: reauthorizationAccount?.userId || req.user._id,
            campaignId: instagramLinkableCampaignId || reauthorizationAccount?.campaignId || undefined,
            platform: 'instagram',
            accountId: igAccountId,
            name: igName,
            username: igUsername,
            accessToken: pageAccessToken, // Instagram operations use page tokens or long-lived user tokens
            authProvider: 'facebook',
            avatarUrl: storedIgAvatarUrl,
            isConnected: true,
            tokenStatus: 'healthy',
            tokenRefreshError: '',
            tokenLastCheckedAt: new Date(),
          },
        });
        connectedAccounts.push(igAccount);
        reauthorizationMatched = reauthorizationMatched || Boolean(reauthorizationAccount);
        if (instagramLinkableCampaignId) {
          await linkAccountToCampaign(instagramLinkableCampaignId, igAccount._id, 'instagram', igAccount.username, igAccount.name, igAccount.accountId, req.user._id, req.user.email || '');
        }
      }
    }

    if (reauthorizationAccount && !reauthorizationMatched) {
      const channelName = reauthorizationAccount.username || reauthorizationAccount.name;
      return res.status(409).json({
        message: `Please authorize the original ${reauthorizationAccount.platform} channel "${channelName}".`,
      });
    }

    res.status(200).json({
      message: `Successfully connected ${connectedAccounts.length} Meta accounts/pages.`,
      accounts: connectedAccounts,
    });
  } catch (error) {
    console.error('❌ Facebook callback handler error:', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

// @desc    Callback from Instagram OAuth to connect a professional Instagram account directly
// @route   POST /api/accounts/instagram-callback
// @access  Private (Owner, Admin)
router.post('/instagram-callback', protect, resolveHandlerPreview, async (req, res) => {
  const { code, redirectUri: requestRedirectUri, campaignId, reauthorizeAccountId } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Authorization code is required' });
  }

  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = requestRedirectUri || process.env.INSTAGRAM_REDIRECT_URI || 'https://theeasypost.com/auth/instagram/callback';

  if (!appId || !appSecret) {
    return res.status(500).json({ message: 'Instagram App credentials are not configured on the backend. Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET from Instagram > API setup with Instagram login.' });
  }

  try {
    const reauthorizationAccount = await getReauthorizationAccount(
      req,
      reauthorizeAccountId,
      'instagram',
      campaignId
    );

    const form = new URLSearchParams();
    form.append('client_id', appId);
    form.append('client_secret', appSecret);
    form.append('grant_type', 'authorization_code');
    form.append('redirect_uri', redirectUri);
    form.append('code', code.replace('#_', ''));

    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('❌ Instagram Token Exchange Failed:', tokenData);
      return res.status(400).json({ message: tokenData.error_message || tokenData.error?.message || 'Instagram token exchange failed' });
    }

    const upgradeUrl = `https://graph.instagram.com/access_token` +
      `?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&access_token=${encodeURIComponent(tokenData.access_token)}`;
    const upgradeRes = await fetch(upgradeUrl);
    const upgradeData = await upgradeRes.json();

    if (!upgradeRes.ok || !upgradeData.access_token) {
      console.error('❌ Instagram Token Upgrade Failed:', upgradeData);
      return res.status(400).json({ message: upgradeData.error?.message || 'Instagram token upgrade failed' });
    }

    const longLivedToken = upgradeData.access_token;
    const profileUrl = `https://graph.instagram.com/v20.0/me?fields=id,user_id,username,name,account_type,profile_picture_url&access_token=${encodeURIComponent(longLivedToken)}`;
    const profileRes = await fetch(profileUrl);
    const profileData = await profileRes.json();

    if (!profileRes.ok) {
      console.error('❌ Instagram Profile Fetch Failed:', profileData);
      return res.status(400).json({ message: profileData.error?.message || 'Failed to fetch Instagram profile' });
    }

    const instagramAccountId = profileData.id || profileData.user_id || tokenData.user_id?.toString();
    const username = profileData.username || 'instagram_account';
    const name = profileData.name || username;
    const tokenExpiresAt = upgradeData.expires_in
      ? new Date(Date.now() + Number(upgradeData.expires_in) * 1000)
      : undefined;

    if (!instagramAccountId) {
      return res.status(400).json({ message: 'Instagram did not return an account ID.' });
    }

    const avatarUrl = await storeRemoteSocialAccountAvatar({
      platform: 'instagram',
      accountId: instagramAccountId,
      avatarUrl: profileData.profile_picture_url || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=150',
    });

    const linkableCampaignId = await getLinkableCampaignId(req, campaignId, {
      platform: 'instagram',
      accountId: instagramAccountId,
      name,
      username,
    });
    if (campaignId && !linkableCampaignId && !hasAdminAccess(req.user)) {
      return res.status(403).json({ message: `@${username} does not match a pending Instagram handle in this campaign.` });
    }

    const accountPayload = {
      platform: 'instagram',
      accountId: instagramAccountId,
      name,
      username,
    };
    if (reauthorizationAccount && !providerAccountMatches(reauthorizationAccount, accountPayload)) {
      return res.status(409).json({
        message: `Please authorize the original Instagram channel @${reauthorizationAccount.username || reauthorizationAccount.name}.`,
      });
    }

    const account = await saveConnectedAccount({
      reauthorizationAccount,
      filter: { userId: req.user._id, platform: 'instagram', accountId: instagramAccountId },
      payload: {
        userId: reauthorizationAccount?.userId || req.user._id,
        campaignId: linkableCampaignId || undefined,
        platform: 'instagram',
        accountId: instagramAccountId,
        name,
        username,
        accessToken: longLivedToken,
        authProvider: 'instagram',
        tokenExpiresAt,
        avatarUrl,
        isConnected: true,
        tokenStatus: 'healthy',
        tokenRefreshError: '',
        tokenLastCheckedAt: new Date(),
      },
    });

    if (linkableCampaignId) {
      await linkAccountToCampaign(linkableCampaignId, account._id, 'instagram', account.username, account.name, account.accountId, req.user._id, req.user.email || '');
    }

    res.status(200).json({
      message: `Successfully connected Instagram account @${username}.`,
      account,
    });
  } catch (error) {
    console.error('❌ Instagram callback handler error:', error.message);
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

// @desc    Get recent 25 published posts for all channels of the logged in user
// @route   GET /api/accounts/posts/recent
// @access  Private
router.get('/posts/recent', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const postQuery = {};
    const campaignId = getActiveCampaignId(req);
    if (campaignId) {
      const accounts = await SocialAccount.find(await getScopedAccountQuery(req)).select('_id').lean();
      postQuery.accountId = { $in: accounts.map((account) => account._id) };
    } else {
      postQuery.userId = getScopedUserId(req);
    }

    const posts = await PublishedPost.find(postQuery)
      .sort({ publishedAt: -1 })
      .limit(25);

    const result = posts.map(post => ({
      id: post.metaPostId,
      accountId: post.accountId,
      content: post.content,
      createdAt: post.publishedAt,
      permalink: post.permalink,
      mediaUrl: post.mediaUrl,
      videoUrl: post.videoUrl,
      mediaType: post.mediaType,
      facebookVideoId: post.facebookVideoId || '',
      viewsSource: post.viewsSource || '',
      views: post.latestViews || 0,
      likes: post.latestLikes || 0,
      comments: post.latestComments || 0,
      commentsPreview: serializeCommentsPreview(post.commentsPreview || []),
      lastSyncedAt: post.lastSyncedAt,
    }));

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/sync', protect, async (req, res) => {
  try {
    if (!getDBStatus()) return res.status(503).json({ message: 'Database disconnected.' });
    const account = await SocialAccount.findOne(getAccountAccessFilter(req, req.params.id)).select('_id');
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    const result = await requestAccountSync(account._id);
    return res.status(202).json({ status: 'queued', ...result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/:id/sync-status', protect, async (req, res) => {
  try {
    if (!getDBStatus()) return res.status(503).json({ message: 'Database disconnected.' });
    const account = await SocialAccount.findOne(getAccountAccessFilter(req, req.params.id)).select('_id');
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    const status = await MetricSyncStatus.findOne({ accountId: account._id, tier: 'manual' }).lean();
    return res.status(200).json(status || { status: 'idle', postsProcessed: 0, lastError: '' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// @desc    Get published posts for a specific account (cache-first; legacy inline refresh supported)
// @route   GET /api/accounts/:id/posts
// @access  Private
router.get('/:id/posts', protect, async (req, res) => {
  const { id } = req.params;
  const forceRefresh = req.query.refresh === 'true';

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Feed is disabled.' });
    }

    const account = await SocialAccount.findOne(getAccountAccessFilter(req, id));
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const isMock = account.accessToken?.startsWith('mock-');
    if (isMock) {
      return res.status(400).json({ message: 'Mock account feed access is disabled.' });
    }

    let liveAccount = account;
    const feedWindowStart = new Date(Date.now() - PUBLISHED_FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const isInFeedWindow = (dateValue) => {
      const time = new Date(dateValue).getTime();
      return Number.isFinite(time) && time >= feedWindowStart.getTime();
    };

    let cachedPosts = [];

    if (!forceRefresh) {
      cachedPosts = await PublishedPost.find({
        accountId: account._id,
        publishedAt: { $gte: feedWindowStart },
      })
        .sort({ publishedAt: -1 })
        .lean();

      return res.status(200).json(cachedPosts.map(serializeCachedPublishedPost));
    }

    // Explicit refresh — fetch from Meta and rewrite the cache.
    try {
      liveAccount = await ensureFreshAccountToken(liveAccount);
    } catch (authErr) {
      await handleProviderAuthFailure(liveAccount, authErr, authErr.message);
      return res.status(401).json({ message: authErr.message || 'Account requires reauthorization.' });
    }

    const getInsightValue = async (postId, metric) => {
      try {
        const graphHost = liveAccount.platform === 'instagram' && liveAccount.authProvider === 'instagram'
          ? 'graph.instagram.com'
          : 'graph.facebook.com';
        const url = `https://${graphHost}/v20.0/${postId}/insights?metric=${metric}&access_token=${liveAccount.accessToken}`;
        const insightRes = await fetch(url);
        const insightData = await insightRes.json();

        if (!insightRes.ok) {
          console.warn(`Meta insight "${metric}" failed for post ${postId}:`, insightData.error?.message || 'Unknown error');
          return null;
        }

        return insightData.data?.[0]?.values?.[0]?.value ?? null;
      } catch (error) {
        console.warn(`Meta insight "${metric}" failed for post ${postId}:`, error.message);
        return null;
      }
    };

    const existingPostMap = new Map(
      (cachedPosts.length > 0
        ? cachedPosts
        : await PublishedPost.find({ accountId: account._id })
          .select('metaPostId latestViews latestLikes latestComments commentsPreview viewsSource facebookVideoId mediaType lastSyncedAt')
          .lean()
      ).map((post) => [post.metaPostId, post])
    );

    // Call actual Meta APIs
    let posts = [];
    if (liveAccount.platform === 'facebook') {
      const url = `https://graph.facebook.com/v20.0/${liveAccount.accountId}/published_posts?fields=id,message,created_time,full_picture,permalink_url,object_id&limit=100&access_token=${liveAccount.accessToken}`;
      const apiResult = await fetchMetaPagedData(url, {
        shouldStop: (pageItems) => pageItems.some((post) => !isInFeedWindow(post.created_time)),
      });
      const apiData = apiResult.data;
      
      if (apiResult.ok) {
        const recentPosts = (apiData.data || []).filter((post) => isInFeedWindow(post.created_time));
        posts = await mapWithConcurrency(recentPosts, LIVE_METRIC_CONCURRENCY, async (post, index) => {
          const existingPost = existingPostMap.get(post.id);
          if (index >= LIVE_METRIC_POST_LIMIT) {
            return {
              id: post.id,
              content: post.message || 'No post message',
              createdAt: post.created_time,
              permalink: post.permalink_url || `https://facebook.com/${post.id}`,
              mediaUrl: post.full_picture || '',
              mediaType: existingPost?.mediaType || (post.full_picture ? 'IMAGE' : ''),
              facebookVideoId: existingPost?.facebookVideoId || '',
              viewsSource: existingPost?.viewsSource || '',
              views: Number(existingPost?.latestViews || 0),
              likes: Number(existingPost?.latestLikes || 0),
              comments: Number(existingPost?.latestComments || 0),
              hasFreshViews: false,
              hasFreshLikes: false,
              hasFreshCommentsCount: false,
              hasFreshMetrics: false,
              lastSyncedAt: existingPost?.lastSyncedAt || null,
              commentsPreview: existingPost?.commentsPreview || [],
            };
          }
          const [viewResult, engagement] = await Promise.all([
            fetchFacebookPostViews(liveAccount.accessToken, post),
            fetchFacebookPostEngagement(liveAccount.accessToken, post.id),
          ]);
          const facebookVideoId = viewResult.videoId || '';
          const hasFreshViews = viewResult.source !== 'unavailable';
          const hasFreshLikes = engagement.likes !== null;

          return {
            id: post.id,
            content: post.message || 'No post message',
            createdAt: post.created_time,
            permalink: post.permalink_url || `https://facebook.com/${post.id}`,
            mediaUrl: post.full_picture || '',
            mediaType: facebookVideoId ? 'VIDEO' : (post.full_picture ? 'IMAGE' : ''),
            facebookVideoId,
            viewsSource: viewResult.source,
            views: hasFreshViews ? Number(viewResult.views) || 0 : Number(existingPost?.latestViews || 0),
            likes: hasFreshLikes ? engagement.likes : Number(existingPost?.latestLikes || 0),
            comments: engagement.comments ?? existingPost?.latestComments ?? 0,
            hasFreshViews,
            hasFreshLikes,
            hasFreshCommentsCount: engagement.comments !== null,
            hasFreshMetrics: hasFreshViews || hasFreshLikes || engagement.comments !== null,
            commentsPreview: existingPost?.commentsPreview || [],
          };
        });
      } else {
        const message = apiData.error?.message || 'Meta API returned an error fetching posts';
        await handleProviderAuthFailure(liveAccount, apiData, message);
        const isPermissionError = apiData.error?.code === 10;
        console.warn(`Meta Facebook feed access failed for ${liveAccount.name}: ${message}`);
        return res.status(apiResult.status || 400).json({ 
          message: isPermissionError
            ? 'Meta denied feed access. Make sure the user manages this Page and the Meta app has the required Page read permission or App Review access.'
            : message
        });
      }
    } else if (liveAccount.platform === 'instagram') {
      const graphHost = liveAccount.authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
      const url = `https://${graphHost}/v20.0/${liveAccount.accountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=100&access_token=${liveAccount.accessToken}`;
      const apiResult = await fetchMetaPagedData(url, {
        shouldStop: (pageItems) => pageItems.some((post) => !isInFeedWindow(post.timestamp)),
      });
      const apiData = apiResult.data;

      if (apiResult.ok) {
        const recentPosts = (apiData.data || []).filter((post) => isInFeedWindow(post.timestamp));
        posts = await mapWithConcurrency(recentPosts, LIVE_METRIC_CONCURRENCY, async (post, index) => {
          const existingPost = existingPostMap.get(post.id);
          const shouldFetchLiveMetrics = index < LIVE_METRIC_POST_LIMIT;
          const views = shouldFetchLiveMetrics
            ? await getInsightValue(post.id, 'views')
            : null;
          const hasFreshViews = views !== null;
          const hasFreshLikes = post.like_count !== undefined;
          const hasFreshCommentsCount = post.comments_count !== undefined;

          return {
            id: post.id,
            content: post.caption || 'No caption',
            createdAt: post.timestamp,
            permalink: post.permalink || `https://instagram.com/p/${post.id}`,
            mediaUrl: post.thumbnail_url || post.media_url || '',
            videoUrl: post.media_type === 'VIDEO' ? post.media_url : '',
            mediaType: post.media_type,
            views: hasFreshViews ? Number(views) || 0 : Number(existingPost?.latestViews || 0),
            likes: hasFreshLikes ? Number(post.like_count) || 0 : Number(existingPost?.latestLikes || 0),
            comments: hasFreshCommentsCount ? Number(post.comments_count) || 0 : Number(existingPost?.latestComments || 0),
            hasFreshViews,
            hasFreshLikes,
            hasFreshCommentsCount,
            hasFreshMetrics: hasFreshViews || hasFreshLikes || hasFreshCommentsCount,
            commentsPreview: existingPost?.commentsPreview || [],
          };
        });
      } else {
        console.error('Meta Instagram Media API error:', apiData);
        await handleProviderAuthFailure(liveAccount, apiData, apiData.error?.message || 'Meta API returned an error fetching posts');
        return res.status(apiResult.status || 400).json({ 
          message: apiData.error?.message || 'Meta API returned an error fetching posts' 
        });
      }
    } else if (liveAccount.platform === 'youtube') {
      posts = (await fetchYoutubeVideos(liveAccount, { limit: LIVE_METRIC_POST_LIMIT }))
        .filter((post) => isInFeedWindow(post.createdAt));
    }

    // Upsert fetched posts into PublishedPost cache
    const syncTime = new Date();

    for (const post of posts) {
      try {
        await PublishedPost.findOneAndUpdate(
          { userId: account.userId, metaPostId: post.id },
          {
            userId: liveAccount.userId,
            campaignId: liveAccount.campaignId,
            accountId: liveAccount._id,
            metaPostId: post.id,
            platform: liveAccount.platform,
            content: post.content,
            mediaUrl: post.mediaUrl,
            videoUrl: post.videoUrl || '',
            mediaType: post.mediaType || '',
            facebookVideoId: post.facebookVideoId || '',
            viewsSource: post.viewsSource || '',
            permalink: post.permalink,
            publishedAt: new Date(post.createdAt),
            ...(post.hasFreshMetrics !== false ? { lastSyncedAt: syncTime } : {}),
            ...(post.hasFreshViews !== false && { latestViews: post.views }),
            ...(post.hasFreshLikes !== false && { latestLikes: post.likes }),
            ...(post.hasFreshCommentsCount !== false && post.comments !== undefined && { latestComments: post.comments }),
            commentsPreview: post.commentsPreview || [],
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
      } catch (upsertErr) {
        if (upsertErr.code !== 11000) {
          console.error(`Failed to cache post ${post.id}:`, upsertErr.message);
        }
      }
    }

    await recordStoredMetricSnapshots(
      liveAccount._id,
      posts.filter((post) => post.hasFreshMetrics !== false).map((post) => post.id),
      syncTime
    ).catch((snapshotError) => {
      console.error('Failed to record manual-refresh metric snapshots:', snapshotError.message);
    });

    // Add lastSyncedAt to each post in the response
    const result = posts.map(post => ({
      ...post,
      lastSyncedAt: post.hasFreshMetrics === false ? post.lastSyncedAt || null : syncTime,
      commentsPreview: serializeCommentsPreview(post.commentsPreview || []),
    }));

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get daily insight trend for a specific post
// @route   GET /api/accounts/:id/posts/:metaPostId/insights
// @access  Private
router.get('/:id/posts/:metaPostId/insights', protect, async (req, res) => {
  const { id, metaPostId } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    // Verify account belongs to user
    const account = await SocialAccount.findOne(getAccountAccessFilter(req, id));
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    // Find the cached published post
    const post = await PublishedPost.findOne({ accountId: account._id, metaPostId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found in cache. Wait for the next feed sync or refresh the feed.' });
    }

    // Fetch all daily insight snapshots for this post
    const insights = await PostInsight.find({ postId: post._id })
      .sort({ dateStr: 1 });

    if (insights.length === 0) {
      return res.status(200).json({
        post: {
          metaPostId: post.metaPostId,
          content: post.content,
          permalink: post.permalink,
          publishedAt: post.publishedAt,
          latestViews: post.latestViews,
          latestLikes: post.latestLikes,
          latestComments: post.latestComments,
          mediaUrl: post.mediaUrl,
          videoUrl: post.videoUrl,
          mediaType: post.mediaType,
        },
        dailyInsights: [],
        message: 'No daily insight snapshots yet. Data will appear after the next daily insight sync.',
      });
    }

    // Calculate daily deltas from cumulative snapshots
    const dailyInsights = insights.map((item, i) => ({
      date: item.dateStr,
      views: i === 0 ? item.views : Math.max(0, item.views - insights[i - 1].views),
      likes: i === 0 ? item.likes : Math.max(0, item.likes - insights[i - 1].likes),
      comments: i === 0 ? item.comments : Math.max(0, item.comments - insights[i - 1].comments),
      // Also include cumulative for reference
      cumulativeViews: item.views,
      cumulativeLikes: item.likes,
      cumulativeComments: item.comments,
    }));

    res.status(200).json({
      post: {
        metaPostId: post.metaPostId,
        content: post.content,
        permalink: post.permalink,
        publishedAt: post.publishedAt,
        latestViews: post.latestViews,
        latestLikes: post.latestLikes,
        latestComments: post.latestComments,
        mediaUrl: post.mediaUrl,
        videoUrl: post.videoUrl,
        mediaType: post.mediaType,
      },
      dailyInsights,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get all campaigns where this creator's connected accounts match the campaign channels
router.get('/creator/campaigns', protect, resolveHandlerPreview, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(200).json([]);
    }

    // 1. Find social accounts controlled by the logged-in creator
    const handlerEmail = (req.user.email || '').trim().toLowerCase();
    const creatorAccounts = await SocialAccount.find({ userId: req.user._id }).lean();
    const accountLookupPairs = creatorAccounts.flatMap((account) => (
      getAccountMatchHandles(account).map((handle) => ({
        platform: account.platform,
        handle,
      }))
    ));
    const creatorAccountKeys = new Set(
      accountLookupPairs.map(({ platform, handle }) => `${platform}:${handle}`)
    );
    const creatorAccountIds = creatorAccounts.map((account) => account._id);
    const creatorAccountsById = new Map(
      creatorAccounts.map((account) => [String(account._id), account])
    );

    const channelConditions = [
      { assignedHandlerUserId: req.user._id },
      ...(handlerEmail ? [{ assignedHandlerEmail: handlerEmail }] : []),
      { socialAccountId: { $in: creatorAccountIds } },
      ...accountLookupPairs.map(({ platform, handle }) => ({
        platform,
        normalizedHandle: handle,
      })),
    ];

    const matchedChannelDocs = await CampaignChannel.find({ $or: channelConditions })
      .sort({ createdAt: 1 })
      .lean();
    if (matchedChannelDocs.length === 0) {
      return res.status(200).json([]);
    }

    const linkedSocialAccountIds = [
      ...new Set(
        matchedChannelDocs
          .map((channel) => channel.socialAccountId)
          .filter(Boolean)
          .map((accountId) => String(accountId))
      ),
    ];
    const linkedSocialAccounts = linkedSocialAccountIds.length > 0
      ? await SocialAccount.find({ _id: { $in: linkedSocialAccountIds } }).lean()
      : [];
    const linkedSocialAccountsById = new Map(
      linkedSocialAccounts.map((account) => [String(account._id), account])
    );

    const matchedCampaignIds = [...new Set(matchedChannelDocs.map((channel) => String(channel.campaignId)))];
    const matchedCampaigns = await Campaign.find({
      _id: { $in: matchedCampaignIds },
      status: { $ne: 'archived' },
    })
      .populate('createdBy', 'name email')
      .lean();

    const channelsByCampaign = new Map();
    matchedChannelDocs.forEach((channel) => {
      const key = String(channel.campaignId);
      if (!channelsByCampaign.has(key)) channelsByCampaign.set(key, []);
      channelsByCampaign.get(key).push(channel);
    });

    // 2. Return only the channels controlled by this creator.
    const enrichedCampaigns = matchedCampaigns.map((campaign) => {
      const creatorChannels = (channelsByCampaign.get(String(campaign._id)) || [])
        .map((channel) => {
          const linkedAccountId = channel.socialAccountId ? String(channel.socialAccountId) : '';
          const linkedCreatorAccount = linkedAccountId
            ? creatorAccountsById.get(linkedAccountId)
            : null;
          const linkedCampaignAccount = linkedAccountId
            ? linkedSocialAccountsById.get(linkedAccountId)
            : null;
          const normalizedHandle = channel.normalizedHandle || normalizeChannelHandle(channel.requestedHandle || channel.handle);
          const matchedAcc = linkedCreatorAccount || linkedCampaignAccount || creatorAccounts.find((account) => (
            account.platform === channel.platform &&
            getAccountMatchHandles(account).includes(normalizedHandle)
          ));
          const isAssignedToCreator = Boolean(
            String(channel.assignedHandlerUserId || '') === String(req.user._id)
            || (handlerEmail && channel.assignedHandlerEmail === handlerEmail)
          );
          const isControlledByCreator = Boolean(
            isAssignedToCreator
            || linkedCreatorAccount
            || (matchedAcc && creatorAccountKeys.has(`${channel.platform}:${normalizedHandle}`))
          );
          if (!isControlledByCreator) return null;

          const isVerified = Boolean(
            matchedAcc
            && matchedAcc.isConnected !== false
            && (channel.status === 'verified' || linkedCreatorAccount || linkedCampaignAccount)
          );
          const status = isVerified
            ? 'verified'
            : isAssignedToCreator
              ? 'manual_only'
              : matchedAcc?._id
              ? 'disconnected'
              : 'pending_verification';

          return {
            _id: channel._id,
            platform: channel.platform,
            handle: channel.requestedHandle,
            requestedHandle: channel.requestedHandle,
            displayName: channel.displayName || '',
            addedAt: channel.createdAt,
            accountId: matchedAcc?.accountId || '',
            name: matchedAcc?.name || channel.displayName || channel.handle,
            username: matchedAcc?.username || normalizedHandle,
            avatarUrl: matchedAcc?.avatarUrl || null,
            isConnected: isVerified,
            isVerified,
            status,
            socialAccountId: matchedAcc?._id || channel.socialAccountId || null,
            matchedAccountId: matchedAcc?._id || null,
            userId: matchedAcc?.userId || channel.assignedHandlerUserId || null,
            assignedHandlerEmail: channel.assignedHandlerEmail || '',
            assignedHandlerUserId: channel.assignedHandlerUserId || null,
            campaignId: campaign._id,
            tokenExpiresAt: matchedAcc?.tokenExpiresAt || null,
            tokenStatus: matchedAcc?.tokenStatus || 'unknown',
            analyticsStatus: matchedAcc?.analyticsStatus || 'unknown',
            analyticsError: matchedAcc?.analyticsError || '',
            verifiedAt: isVerified ? (matchedAcc.updatedAt || matchedAcc.createdAt || null) : null,
            verifiedByUserId: isVerified ? matchedAcc.userId : null,
          };
        })
        .filter(Boolean);

      return {
        ...campaign,
        accountIds: creatorChannels
          .map((channel) => channel.socialAccountId)
          .filter(Boolean),
        channels: creatorChannels,
        isCreatorParticipant: creatorChannels.length > 0,
      };
    });

    res.status(200).json(enrichedCampaigns.filter((campaign) => campaign.channels.length > 0));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
