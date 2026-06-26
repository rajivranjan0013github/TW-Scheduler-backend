import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import SocialAccount from '../models/SocialAccount.js';
import Campaign from '../models/Campaign.js';
import Insight from '../models/Insight.js';
import PublishedPost from '../models/PublishedPost.js';
import PostInsight from '../models/PostInsight.js';
import { protect, authorize } from '../middleware/auth.js';
import { getYoutubeAuthUrl, exchangeYoutubeCodeForAccount, fetchYoutubeVideos } from '../services/youtubeService.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from '../services/tokenHealthService.js';
import {
  fetchFacebookPostInsightValue,
  fetchFacebookPostViews,
} from '../services/facebookMetricsService.js';
import {
  canAccountVerifyCampaign,
  linkSocialAccountToCampaignChannels,
  normalizeChannelHandle,
  resolveCampaignPublishingChannels,
} from '../utils/campaignChannels.js';
import CampaignChannel from '../models/CampaignChannel.js';

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
const INSIGHT_SKIP_MS = 15 * 60 * 1000;
const ADMIN_ROLES = ['owner', 'admin'];
const hasAdminAccess = (user) => ADMIN_ROLES.includes(user?.role) && user?.userType !== 'account_handler';

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

const linkAccountToCampaign = async (campaignId, socialAccountId, platform, username, name, accountId) => {
  if (!campaignId || !socialAccountId) return;
  try {
    await linkSocialAccountToCampaignChannels(campaignId, {
      _id: socialAccountId,
      platform,
      username,
      name,
      accountId,
      isConnected: true,
    });
  } catch (err) {
    console.error('Failed to link account to campaign:', err.message);
  }
};

// @desc    Get all connected accounts
// @route   GET /api/accounts
// @access  Private
router.get('/', protect, async (req, res) => {
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
router.get('/publishing-channels', protect, async (req, res) => {
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
        { socialAccountId: { $in: creatorAccountIds } },
        ...accountLookupPairs.map(({ platform, handle }) => ({
          platform,
          normalizedHandle: handle,
        })),
      ];

      if (channelConditions.length === 0) {
        return res.status(200).json([]);
      }

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
          if (!matchedAcc) return null;

          const isVerified = Boolean(matchedAcc.isConnected !== false);
          return {
            _id: channel._id,
            platform: channel.platform,
            handle: channel.requestedHandle,
            requestedHandle: channel.requestedHandle,
            displayName: channel.displayName || '',
            addedAt: channel.createdAt,
            socialAccountId: isVerified ? matchedAcc._id : null,
            accountId: matchedAcc.accountId || '',
            name: matchedAcc.name || channel.displayName || channel.requestedHandle,
            username: matchedAcc.username || normalizedHandle,
            avatarUrl: matchedAcc.avatarUrl || null,
            isConnected: isVerified,
            isVerified,
            status: isVerified ? 'verified' : 'disconnected',
            userId: matchedAcc.userId,
            campaignId,
            tokenExpiresAt: matchedAcc.tokenExpiresAt || null,
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
router.get('/campaigns', protect, async (req, res) => {
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
router.post('/connect', protect, async (req, res) => {
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

    let account = await SocialAccount.findOne({ userId: req.user._id, accountId });
    if (account) {
      account.isConnected = true;
      account.accessToken = accessToken || 'mock-access-token';
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
        avatarUrl,
        tokenStatus: 'healthy',
        tokenLastCheckedAt: new Date(),
      });
    }

    if (linkableCampaignId) {
      await linkAccountToCampaign(linkableCampaignId, account._id, platform, username, name, accountId);
    }

    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get YouTube OAuth URL
// @route   GET /api/accounts/youtube/auth-url
// @access  Private (Owner, Admin)
router.get('/youtube/auth-url', protect, async (req, res) => {
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
router.post('/youtube-callback', protect, async (req, res) => {
  const { code, campaignId } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Authorization code is required' });
  }

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. YouTube channel connection requires MongoDB.' });
    }

    const accountPayload = await exchangeYoutubeCodeForAccount(code, req.user._id);
    const linkableCampaignId = await getLinkableCampaignId(req, campaignId, accountPayload);
    if (campaignId && !linkableCampaignId && !hasAdminAccess(req.user)) {
      return res.status(403).json({ message: 'This YouTube channel does not match the campaign handle.' });
    }

    const account = await SocialAccount.findOneAndUpdate(
      {
        userId: req.user._id,
        platform: 'youtube',
        accountId: accountPayload.accountId,
      },
      {
        ...accountPayload,
        campaignId: linkableCampaignId || undefined,
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    if (linkableCampaignId) {
      await linkAccountToCampaign(linkableCampaignId, account._id, 'youtube', account.username, account.name, account.accountId);
    }

    res.status(200).json({
      message: `Successfully connected YouTube channel "${account.name}".`,
      account,
    });
  } catch (error) {
    console.error('❌ YouTube callback handler error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// @desc    Disconnect an account
// @route   DELETE /api/accounts/:id
// @access  Private (Owner, Admin)
router.delete('/:id', protect, async (req, res) => {
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
router.post('/facebook-callback', protect, async (req, res) => {
  const { code, campaignId } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Authorization code is required' });
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI || 'http://localhost:5173/auth/facebook/callback';

  if (!appId || !appSecret) {
    return res.status(500).json({ message: 'Meta App credentials are not configured on the backend.' });
  }

  try {
    
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
    try {
      const debugUrl = `https://graph.facebook.com/debug_token?input_token=${longLivedUserToken}&access_token=${appId}|${appSecret}`;
      const debugRes = await fetch(debugUrl);
      const debugData = await debugRes.json();
      
      if (debugData?.data?.granular_scopes) {
        for (const gs of debugData.data.granular_scopes) {
          if (gs.scope?.startsWith('pages_') && gs.target_ids) {
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

    // 4. Process each page and linked Instagram account
    for (const page of pagesList) {
      const pageAccessToken = page.access_token; // Permanent page-scoped token
      const pageId = page.id;
      const pageName = page.name;
      const pageUsername = page.username || pageName.toLowerCase().replace(/\s+/g, '');

      // Get page avatar from metadata or fallback
      const pagePicUrl = `https://graph.facebook.com/v20.0/${pageId}/picture?type=normal&access_token=${pageAccessToken}`;

      
      const linkableCampaignId = await getLinkableCampaignId(req, campaignId, {
        platform: 'facebook',
        accountId: pageId,
        name: pageName,
        username: pageUsername,
      });

      // Upsert Facebook Page in database
      let fbAccount = await SocialAccount.findOneAndUpdate(
        { userId: req.user._id, accountId: pageId },
        {
          userId: req.user._id,
          campaignId: linkableCampaignId || undefined,
          platform: 'facebook',
          name: pageName,
          username: pageUsername,
          accessToken: pageAccessToken,
          authProvider: 'facebook',
          avatarUrl: pagePicUrl,
          isConnected: true,
          tokenStatus: 'healthy',
          tokenRefreshError: '',
          tokenLastCheckedAt: new Date(),
        },
        { upsert: true, returnDocument: 'after' }
      );
      connectedAccounts.push(fbAccount);
      if (linkableCampaignId) {
        await linkAccountToCampaign(linkableCampaignId, fbAccount._id, 'facebook', fbAccount.username, fbAccount.name, fbAccount.accountId);
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

        const instagramLinkableCampaignId = await getLinkableCampaignId(req, campaignId, {
          platform: 'instagram',
          accountId: igAccountId,
          name: igName,
          username: igUsername,
        });

        // Upsert Instagram Account in database
        let igAccount = await SocialAccount.findOneAndUpdate(
          { userId: req.user._id, accountId: igAccountId },
          {
            userId: req.user._id,
            campaignId: instagramLinkableCampaignId || undefined,
            platform: 'instagram',
            name: igName,
            username: igUsername,
            accessToken: pageAccessToken, // Instagram operations use page tokens or long-lived user tokens
            authProvider: 'facebook',
            avatarUrl: igAvatarUrl,
            isConnected: true,
            tokenStatus: 'healthy',
            tokenRefreshError: '',
            tokenLastCheckedAt: new Date(),
          },
          { upsert: true, returnDocument: 'after' }
        );
        connectedAccounts.push(igAccount);
        if (instagramLinkableCampaignId) {
          await linkAccountToCampaign(instagramLinkableCampaignId, igAccount._id, 'instagram', igAccount.username, igAccount.name, igAccount.accountId);
        }
      }
    }

    res.status(200).json({
      message: `Successfully connected ${connectedAccounts.length} Meta accounts/pages.`,
      accounts: connectedAccounts,
    });
  } catch (error) {
    console.error('❌ Facebook callback handler error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// @desc    Callback from Instagram OAuth to connect a professional Instagram account directly
// @route   POST /api/accounts/instagram-callback
// @access  Private (Owner, Admin)
router.post('/instagram-callback', protect, async (req, res) => {
  const { code, redirectUri: requestRedirectUri, campaignId } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Authorization code is required' });
  }

  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = requestRedirectUri || process.env.INSTAGRAM_REDIRECT_URI || 'http://localhost:5173/auth/instagram/callback';

  if (!appId || !appSecret) {
    return res.status(500).json({ message: 'Instagram App credentials are not configured on the backend. Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET from Instagram > API setup with Instagram login.' });
  }

  try {

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

    const linkableCampaignId = await getLinkableCampaignId(req, campaignId, {
      platform: 'instagram',
      accountId: instagramAccountId,
      name,
      username,
    });
    if (campaignId && !linkableCampaignId && !hasAdminAccess(req.user)) {
      return res.status(403).json({ message: `@${username} does not match a pending Instagram handle in this campaign.` });
    }

    const account = await SocialAccount.findOneAndUpdate(
      { userId: req.user._id, platform: 'instagram', accountId: instagramAccountId },
      {
        userId: req.user._id,
        campaignId: linkableCampaignId || undefined,
        platform: 'instagram',
        accountId: instagramAccountId,
        name,
        username,
        accessToken: longLivedToken,
        authProvider: 'instagram',
        tokenExpiresAt,
        avatarUrl: profileData.profile_picture_url || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=150',
        isConnected: true,
        tokenStatus: 'healthy',
        tokenRefreshError: '',
        tokenLastCheckedAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' }
    );

    if (linkableCampaignId) {
      await linkAccountToCampaign(linkableCampaignId, account._id, 'instagram', account.username, account.name, account.accountId);
    }

    res.status(200).json({
      message: `Successfully connected Instagram account @${username}.`,
      account,
    });
  } catch (error) {
    console.error('❌ Instagram callback handler error:', error.message);
    res.status(500).json({ message: error.message });
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

// @desc    Get published posts for a specific account (cached-first, 2h staleness)
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

    // Check for cached posts and their freshness (2 hour threshold)
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    let cachedPosts = [];

    if (!forceRefresh) {
      cachedPosts = await PublishedPost.find({ accountId: account._id })
        .sort({ publishedAt: -1 })
        .limit(25);

      if (cachedPosts.length > 0) {
        const mostRecentSync = cachedPosts[0].lastSyncedAt;
        const isFresh = mostRecentSync && (Date.now() - new Date(mostRecentSync).getTime()) < TWO_HOURS_MS;

        if (isFresh) {
          // Return cached data directly
          const result = cachedPosts.map(post => ({
            id: post.metaPostId,
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
          return res.status(200).json(result);
        }
      }
    }

    // Cache is stale or empty or force refresh — fetch from Meta
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
          return 0;
        }

        return insightData.data?.[0]?.values?.[0]?.value || 0;
      } catch (error) {
        console.warn(`Meta insight "${metric}" failed for post ${postId}:`, error.message);
        return 0;
      }
    };

    const getCommentsPreview = async (postId) => {
      try {
        const graphHost = liveAccount.platform === 'instagram' && liveAccount.authProvider === 'instagram'
          ? 'graph.instagram.com'
          : 'graph.facebook.com';
        const fields = liveAccount.platform === 'facebook'
          ? 'id,from,message,created_time'
          : 'id,username,text,timestamp';
        const url = `https://${graphHost}/v20.0/${postId}/comments?fields=${fields}&limit=3&access_token=${liveAccount.accessToken}`;
        const commentsRes = await fetch(url);
        const commentsData = await commentsRes.json();

        if (!commentsRes.ok) {
          console.warn(`Comments preview failed for post ${postId}:`, commentsData.error?.message || 'Unknown error');
          return [];
        }

        return serializeCommentsPreview(commentsData.data || []);
      } catch (error) {
        console.warn(`Comments preview failed for post ${postId}:`, error.message);
        return [];
      }
    };

    // Call actual Meta APIs
    let posts = [];
    if (liveAccount.platform === 'facebook') {
      const url = `https://graph.facebook.com/v20.0/${liveAccount.accountId}/published_posts?fields=id,message,created_time,full_picture,permalink_url&limit=25&access_token=${liveAccount.accessToken}`;
      const apiRes = await fetch(url);
      const apiData = await apiRes.json();
      
      if (apiRes.ok) {
        posts = await Promise.all((apiData.data || []).map(async (post) => {
          const [viewResult, likes, commentsPreview] = await Promise.all([
            fetchFacebookPostViews(liveAccount.accessToken, post),
            fetchFacebookPostInsightValue(liveAccount.accessToken, post.id, 'post_reactions_like_total').catch((error) => {
              console.warn(`Meta insight "post_reactions_like_total" failed for post ${post.id}:`, error.message);
              return 0;
            }),
            getCommentsPreview(post.id),
          ]);
          const facebookVideoId = viewResult.videoId || '';

          return {
            id: post.id,
            content: post.message || 'No post message',
            createdAt: post.created_time,
            permalink: post.permalink_url || `https://facebook.com/${post.id}`,
            mediaUrl: post.full_picture || '',
            mediaType: facebookVideoId ? 'VIDEO' : (post.full_picture ? 'IMAGE' : ''),
            facebookVideoId,
            viewsSource: viewResult.source,
            views: Number(viewResult.views) || 0,
            likes: Number(likes) || 0,
            comments: 0,
            commentsPreview,
          };
        }));
      } else {
        const message = apiData.error?.message || 'Meta API returned an error fetching posts';
        await handleProviderAuthFailure(liveAccount, apiData, message);
        const isPermissionError = apiData.error?.code === 10;
        console.warn(`Meta Facebook feed access failed for ${liveAccount.name}: ${message}`);
        return res.status(apiRes.status || 400).json({ 
          message: isPermissionError
            ? 'Meta denied feed access. Make sure the user manages this Page and the Meta app has the required Page read permission or App Review access.'
            : message
        });
      }
    } else if (liveAccount.platform === 'instagram') {
      const graphHost = liveAccount.authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
      const url = `https://${graphHost}/v20.0/${liveAccount.accountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&access_token=${liveAccount.accessToken}`;
      const apiRes = await fetch(url);
      const apiData = await apiRes.json();

      if (apiRes.ok) {
        posts = await Promise.all((apiData.data || []).map(async (post) => {
          const [views, insightLikes, insightComments, commentsPreview] = await Promise.all([
            getInsightValue(post.id, 'views'),
            getInsightValue(post.id, 'likes'),
            getInsightValue(post.id, 'comments'),
            getCommentsPreview(post.id),
          ]);

          return {
            id: post.id,
            content: post.caption || 'No caption',
            createdAt: post.timestamp,
            permalink: post.permalink || `https://instagram.com/p/${post.id}`,
            mediaUrl: post.thumbnail_url || post.media_url || '',
            videoUrl: post.media_type === 'VIDEO' ? post.media_url : '',
            mediaType: post.media_type,
            views: Number(views) || 0,
            likes: Number(insightLikes || post.like_count) || 0,
            comments: Number(insightComments || post.comments_count) || 0,
            commentsPreview,
          };
        }));
      } else {
        console.error('Meta Instagram Media API error:', apiData);
        await handleProviderAuthFailure(liveAccount, apiData, apiData.error?.message || 'Meta API returned an error fetching posts');
        return res.status(apiRes.status || 400).json({ 
          message: apiData.error?.message || 'Meta API returned an error fetching posts' 
        });
      }
    } else if (liveAccount.platform === 'youtube') {
      posts = await fetchYoutubeVideos(liveAccount);
    }

    // Upsert fetched posts into PublishedPost cache
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
            lastSyncedAt: new Date(),
            latestViews: post.views,
            latestLikes: post.likes,
            latestComments: post.comments,
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

    // Add lastSyncedAt to each post in the response
    const result = posts.map(post => ({
      ...post,
      lastSyncedAt: new Date(),
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
router.get('/creator/campaigns', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(200).json([]);
    }

    // 1. Find social accounts controlled by the logged-in creator
    const creatorAccounts = await SocialAccount.find({ userId: req.user._id }).lean();
    if (creatorAccounts.length === 0) {
      return res.status(200).json([]);
    }

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
      { socialAccountId: { $in: creatorAccountIds } },
      ...accountLookupPairs.map(({ platform, handle }) => ({
        platform,
        normalizedHandle: handle,
      })),
    ];

    if (channelConditions.length === 0) {
      return res.status(200).json([]);
    }

    const matchedChannelDocs = await CampaignChannel.find({ $or: channelConditions })
      .sort({ createdAt: 1 })
      .lean();
    if (matchedChannelDocs.length === 0) {
      return res.status(200).json([]);
    }

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
          const normalizedHandle = channel.normalizedHandle || normalizeChannelHandle(channel.requestedHandle || channel.handle);
          const matchedAcc = linkedCreatorAccount || creatorAccounts.find((account) => (
            account.platform === channel.platform &&
            getAccountMatchHandles(account).includes(normalizedHandle)
          ));
          const isControlledByCreator = Boolean(
            linkedCreatorAccount || (matchedAcc && creatorAccountKeys.has(`${channel.platform}:${normalizedHandle}`))
          );
          if (!isControlledByCreator) return null;

          const isVerified = Boolean(matchedAcc.isConnected !== false);
          const status = isVerified
            ? 'verified'
            : matchedAcc._id
              ? 'disconnected'
              : 'pending_verification';

          return {
            _id: channel._id,
            platform: channel.platform,
            handle: channel.requestedHandle,
            requestedHandle: channel.requestedHandle,
            displayName: channel.displayName || '',
            addedAt: channel.createdAt,
            accountId: matchedAcc.accountId || '',
            name: matchedAcc.name || channel.displayName || channel.handle,
            username: matchedAcc.username || normalizedHandle,
            avatarUrl: matchedAcc.avatarUrl || null,
            isConnected: isVerified,
            isVerified,
            status,
            socialAccountId: isVerified ? matchedAcc._id : null,
            matchedAccountId: matchedAcc._id,
            userId: matchedAcc.userId,
            campaignId: campaign._id,
            tokenExpiresAt: matchedAcc.tokenExpiresAt || null,
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
