import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import SocialAccount from '../models/SocialAccount.js';
import Insight from '../models/Insight.js';
import PublishedPost from '../models/PublishedPost.js';
import PostInsight from '../models/PostInsight.js';
import { protect, authorize } from '../middleware/auth.js';
import { getYoutubeAuthUrl, exchangeYoutubeCodeForAccount, fetchYoutubeVideos } from '../services/youtubeService.js';

const router = express.Router();
const insightSkipCache = new Map();
const INSIGHT_SKIP_MS = 15 * 60 * 1000;

// @desc    Get all connected accounts
// @route   GET /api/accounts
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const accounts = await SocialAccount.find({ userId: req.user._id });
    res.status(200).json(accounts);
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

    const accounts = await SocialAccount.find({ userId: req.user._id, isConnected: true });
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
      const isMock = account.accessToken?.startsWith('mock-');
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
          // Real Meta API query range
          const datesSorted = [...targetDates].sort();
          const targetSinceDate = new Date(datesSorted[0]);
          const targetUntilDate = new Date(datesSorted[datesSorted.length - 1]);
          targetUntilDate.setDate(targetUntilDate.getDate() + 1);

          const targetSince = Math.floor(targetSinceDate.getTime() / 1000);
          const targetUntil = Math.floor(targetUntilDate.getTime() / 1000);

          try {
            const metric = account.platform === 'facebook' ? 'page_post_engagements' : 'reach';
            const apiValues = await fetchDailyInsightValues(account, [metric], targetSince, targetUntil);
            
            for (const item of apiValues) {
              const dateStr = item.end_time.split('T')[0];
              if (targetDates.includes(dateStr)) {
                results[dateStr] = item.value;
              }
            }
          } catch (apiErr) {
            console.error(`Meta fetch failed for ${account.name}:`, apiErr.message);
          }
        }

        // Cache retrieved dates in MongoDB (including today's current count)
        const insertDocs = Object.keys(results).map(dateStr => ({
          accountId: account._id,
          dateStr,
          platform: account.platform,
          value: results[dateStr]
        }));

        for (const doc of insertDocs) {
          try {
            await Insight.findOneAndUpdate(
              { accountId: doc.accountId, dateStr: doc.dateStr },
              doc,
              { upsert: true, new: true }
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

        if (account.platform === 'instagram') {
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
router.post('/connect', protect, authorize('owner', 'admin'), async (req, res) => {
  const { platform, accountId, name, username, accessToken, avatarUrl } = req.body;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    let account = await SocialAccount.findOne({ userId: req.user._id, accountId });
    if (account) {
      account.isConnected = true;
      account.accessToken = accessToken || 'mock-access-token';
      await account.save();
    } else {
      account = await SocialAccount.create({
        userId: req.user._id,
        platform,
        accountId,
        name,
        username,
        accessToken: accessToken || 'mock-access-token',
        avatarUrl,
      });
    }


    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get YouTube OAuth URL
// @route   GET /api/accounts/youtube/auth-url
// @access  Private (Owner, Admin)
router.get('/youtube/auth-url', protect, authorize('owner', 'admin'), async (req, res) => {
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
router.post('/youtube-callback', protect, authorize('owner', 'admin'), async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Authorization code is required' });
  }

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. YouTube channel connection requires MongoDB.' });
    }

    const accountPayload = await exchangeYoutubeCodeForAccount(code, req.user._id);
    const account = await SocialAccount.findOneAndUpdate(
      {
        userId: req.user._id,
        platform: 'youtube',
        accountId: accountPayload.accountId,
      },
      accountPayload,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

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
router.delete('/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    const account = await SocialAccount.findOne({ _id: id, userId: req.user._id });
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    await SocialAccount.deleteOne({ _id: id, userId: req.user._id });
    res.status(200).json({ message: 'Account disconnected successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Callback from Facebook OAuth to connect accounts
// @route   POST /api/accounts/facebook-callback
// @access  Private (Owner, Admin)
router.post('/facebook-callback', protect, authorize('owner', 'admin'), async (req, res) => {
  const { code } = req.body;
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

      
      // Upsert Facebook Page in database
      let fbAccount = await SocialAccount.findOneAndUpdate(
        { userId: req.user._id, accountId: pageId },
        {
          userId: req.user._id,
          platform: 'facebook',
          name: pageName,
          username: pageUsername,
          accessToken: pageAccessToken,
          authProvider: 'facebook',
          avatarUrl: pagePicUrl,
          isConnected: true,
        },
        { upsert: true, new: true }
      );
      connectedAccounts.push(fbAccount);

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

        // Upsert Instagram Account in database
        let igAccount = await SocialAccount.findOneAndUpdate(
          { userId: req.user._id, accountId: igAccountId },
          {
            userId: req.user._id,
            platform: 'instagram',
            name: igName,
            username: igUsername,
            accessToken: pageAccessToken, // Instagram operations use page tokens or long-lived user tokens
            authProvider: 'facebook',
            avatarUrl: igAvatarUrl,
            isConnected: true,
          },
          { upsert: true, new: true }
        );
        connectedAccounts.push(igAccount);
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
router.post('/instagram-callback', protect, authorize('owner', 'admin'), async (req, res) => {
  const { code, redirectUri: requestRedirectUri } = req.body;
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

    const account = await SocialAccount.findOneAndUpdate(
      { userId: req.user._id, platform: 'instagram', accountId: instagramAccountId },
      {
        userId: req.user._id,
        platform: 'instagram',
        accountId: instagramAccountId,
        name,
        username,
        accessToken: longLivedToken,
        authProvider: 'instagram',
        tokenExpiresAt,
        avatarUrl: profileData.profile_picture_url || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=150',
        isConnected: true,
      },
      { upsert: true, new: true }
    );

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

    const posts = await PublishedPost.find({ userId: req.user._id })
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
      views: post.latestViews || 0,
      likes: post.latestLikes || 0,
      comments: post.latestComments || 0,
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

    const account = await SocialAccount.findOne({ _id: id, userId: req.user._id });
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const isMock = account.accessToken?.startsWith('mock-');
    if (isMock) {
      return res.status(400).json({ message: 'Mock account feed access is disabled.' });
    }

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
            views: post.latestViews || 0,
            likes: post.latestLikes || 0,
            comments: post.latestComments || 0,
            lastSyncedAt: post.lastSyncedAt,
          }));
          return res.status(200).json(result);
        }
      }
    }

    // Cache is stale or empty or force refresh — fetch from Meta
    const getInsightValue = async (postId, metric) => {
      try {
        const graphHost = account.platform === 'instagram' && account.authProvider === 'instagram'
          ? 'graph.instagram.com'
          : 'graph.facebook.com';
        const url = `https://${graphHost}/v20.0/${postId}/insights?metric=${metric}&access_token=${account.accessToken}`;
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

    // Call actual Meta APIs
    let posts = [];
    if (account.platform === 'facebook') {
      const url = `https://graph.facebook.com/v20.0/${account.accountId}/published_posts?fields=id,message,created_time,full_picture,permalink_url&limit=25&access_token=${account.accessToken}`;
      const apiRes = await fetch(url);
      const apiData = await apiRes.json();
      
      if (apiRes.ok) {
        posts = await Promise.all((apiData.data || []).map(async (post) => {
          const [views, likes, activityByType] = await Promise.all([
            getInsightValue(post.id, 'post_impressions_unique'),
            getInsightValue(post.id, 'post_reactions_like_total'),
            getInsightValue(post.id, 'post_activity_by_action_type'),
          ]);

          return {
            id: post.id,
            content: post.message || 'No post message',
            createdAt: post.created_time,
            permalink: post.permalink_url || `https://facebook.com/${post.id}`,
            mediaUrl: post.full_picture || '',
            views: Number(views) || 0,
            likes: Number(likes) || 0,
            comments: Number(activityByType?.comment) || 0
          };
        }));
      } else {
        const message = apiData.error?.message || 'Meta API returned an error fetching posts';
        const isPermissionError = apiData.error?.code === 10;
        console.warn(`Meta Facebook feed access failed for ${account.name}: ${message}`);
        return res.status(apiRes.status || 400).json({ 
          message: isPermissionError
            ? 'Meta denied feed access. Make sure the user manages this Page and the Meta app has the required Page read permission or App Review access.'
            : message
        });
      }
    } else if (account.platform === 'instagram') {
      const graphHost = account.authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
      const url = `https://${graphHost}/v20.0/${account.accountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&access_token=${account.accessToken}`;
      const apiRes = await fetch(url);
      const apiData = await apiRes.json();

      if (apiRes.ok) {
        posts = await Promise.all((apiData.data || []).map(async (post) => {
          const [views, insightLikes, insightComments] = await Promise.all([
            getInsightValue(post.id, 'views'),
            getInsightValue(post.id, 'likes'),
            getInsightValue(post.id, 'comments'),
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
            comments: Number(insightComments || post.comments_count) || 0
          };
        }));
      } else {
        console.error('Meta Instagram Media API error:', apiData);
        return res.status(apiRes.status || 400).json({ 
          message: apiData.error?.message || 'Meta API returned an error fetching posts' 
        });
      }
    } else if (account.platform === 'youtube') {
      posts = await fetchYoutubeVideos(account);
    }

    // Upsert fetched posts into PublishedPost cache
    for (const post of posts) {
      try {
        await PublishedPost.findOneAndUpdate(
          { userId: req.user._id, metaPostId: post.id },
          {
            userId: req.user._id,
            accountId: account._id,
            metaPostId: post.id,
            platform: account.platform,
            content: post.content,
            mediaUrl: post.mediaUrl,
            videoUrl: post.videoUrl || '',
            mediaType: post.mediaType || '',
            permalink: post.permalink,
            publishedAt: new Date(post.createdAt),
            lastSyncedAt: new Date(),
            latestViews: post.views,
            latestLikes: post.likes,
            latestComments: post.comments,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
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
    const account = await SocialAccount.findOne({ _id: id, userId: req.user._id });
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

export default router;
