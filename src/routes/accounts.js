import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import SocialAccount from '../models/SocialAccount.js';
import { protect, authorize } from '../middleware/auth.js';

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

    const accounts = await SocialAccount.find();
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

    const accounts = await SocialAccount.find({ isConnected: true });
    if (accounts.length === 0) {
      return res.status(200).json([]);
    }

    // Days map for sorting and naming
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    // Initialize a daily aggregation map for the last 7 days
    const chartMap = {};
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayName = dayNames[d.getDay()];
      chartMap[dateStr] = {
        name: dayName,
        Instagram: 0,
        Facebook: 0
      };
    }

    const fetchDailyInsightValues = async (account, metricCandidates) => {
      const invalidMetrics = [];

      for (const metric of metricCandidates) {
        const url = `https://graph.facebook.com/v20.0/${account.accountId}/insights?metric=${metric}&period=day&access_token=${account.accessToken}`;
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

    // Loop through each account and fetch actual daily views/reach
    for (const account of accounts) {
      const isMock = account.accessToken?.startsWith('mock-');
      const skipUntil = insightSkipCache.get(account._id.toString());
      if (skipUntil && skipUntil > Date.now()) {
        continue;
      }
      
      let insightsData = [];

      if (!isMock) {
        try {
          if (account.platform === 'facebook') {
            insightsData = await fetchDailyInsightValues(account, ['page_post_engagements']);
          } else if (account.platform === 'instagram') {
            // Instagram impressions is deprecated for newer API behavior; reach is still accepted for account insights.
            insightsData = await fetchDailyInsightValues(account, ['reach']);
          }
        } catch (err) {
          insightSkipCache.set(account._id.toString(), Date.now() + INSIGHT_SKIP_MS);
          console.warn(`Skipping insights for ${account.name} for 15 minutes: ${err.message}`);
          continue;
        }
      }

      // If we got real insights, add them to the daily chart data
      if (insightsData.length > 0) {
        for (const item of insightsData) {
          // Meta end_time format is e.g. "2026-06-15T07:00:00+0000"
          const dateStr = item.end_time.split('T')[0];
          if (chartMap[dateStr]) {
            if (account.platform === 'instagram') {
              chartMap[dateStr].Instagram += item.value;
            } else {
              chartMap[dateStr].Facebook += item.value;
            }
          }
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

    let account = await SocialAccount.findOne({ accountId });
    if (account) {
      account.isConnected = true;
      account.accessToken = accessToken || 'mock-access-token';
      await account.save();
    } else {
      account = await SocialAccount.create({
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

    const account = await SocialAccount.findById(id);
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    await SocialAccount.findByIdAndDelete(id);
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
    console.log('🤖 [Meta OAuth] Exchanging authorization code for user access token...');
    
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
    console.log('🤖 [Meta OAuth] Upgrading user token to long-lived (60 days)...');
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
      console.log('🤖 [Meta OAuth] Token Info:', JSON.stringify(debugData));
      
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
    console.log('🤖 [Meta OAuth] Fetching associated Facebook Pages...');
    const pagesUrl = `https://graph.facebook.com/v20.0/me/accounts?access_token=${longLivedUserToken}`;
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();
    console.log('🤖 [Meta OAuth] pagesData response:', JSON.stringify(pagesData));

    if (!pagesRes.ok) {
      console.error('❌ Fetching Facebook Pages Failed:', pagesData);
      return res.status(400).json({ message: pagesData.error?.message || 'Failed to fetch Facebook Pages' });
    }

    let pagesList = pagesData.data || [];

    // Fallback: if pagesList is empty or missing targetPageIds, fetch them directly
    for (const pageId of targetPageIds) {
      if (!pagesList.some(p => p.id === pageId)) {
        console.log(`🤖 [Meta OAuth] Fallback: Fetching Page ${pageId} details directly...`);
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
            console.log(`🤖 [Meta OAuth] Fallback: Successfully retrieved Page "${directPageData.name}" directly.`);
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

      console.log(`🤖 [Meta OAuth] Registering Facebook Page: "${pageName}" (${pageId})`);
      
      // Upsert Facebook Page in database
      let fbAccount = await SocialAccount.findOneAndUpdate(
        { accountId: pageId },
        {
          platform: 'facebook',
          name: pageName,
          username: pageUsername,
          accessToken: pageAccessToken,
          avatarUrl: pagePicUrl,
          isConnected: true,
        },
        { upsert: true, new: true }
      );
      connectedAccounts.push(fbAccount);

      // Find linked Instagram Business Account ID
      console.log(`🤖 [Meta OAuth] Searching for linked Instagram accounts for Facebook Page ID: ${pageId}...`);
      const igCheckUrl = `https://graph.facebook.com/v20.0/${pageId}?fields=instagram_business_account&access_token=${pageAccessToken}`;
      const igCheckRes = await fetch(igCheckUrl);
      const igCheckData = await igCheckRes.json();

      if (igCheckRes.ok && igCheckData.instagram_business_account) {
        const igAccountId = igCheckData.instagram_business_account.id;
        console.log(`🤖 [Meta OAuth] Linked Instagram Business Account found ID: ${igAccountId}. Fetching profile details...`);

        // Fetch Instagram Account details
        const igDetailUrl = `https://graph.facebook.com/v20.0/${igAccountId}?fields=name,username,profile_picture_url&access_token=${pageAccessToken}`;
        const igDetailRes = await fetch(igDetailUrl);
        const igDetailData = await igDetailRes.json();

        const igName = igDetailData.name || 'Instagram Account';
        const igUsername = igDetailData.username || 'instagram_account';
        const igAvatarUrl = igDetailData.profile_picture_url || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=150';

        // Upsert Instagram Account in database
        let igAccount = await SocialAccount.findOneAndUpdate(
          { accountId: igAccountId },
          {
            platform: 'instagram',
            name: igName,
            username: igUsername,
            accessToken: pageAccessToken, // Instagram operations use page tokens or long-lived user tokens
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

// @desc    Get published posts for a specific account
// @route   GET /api/accounts/:id/posts
// @access  Private
router.get('/:id/posts', protect, async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Sandbox feed is disabled.' });
    }

    const account = await SocialAccount.findById(id);
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const isMock = account.accessToken?.startsWith('mock-');
    if (isMock) {
      return res.status(400).json({ message: 'Mock account feed access is disabled.' });
    }

    // Call actual Meta APIs
    let posts = [];
    if (account.platform === 'facebook') {
      const url = `https://graph.facebook.com/v20.0/${account.accountId}/published_posts?fields=id,message,created_time,full_picture,permalink_url,likes.summary(true).limit(0),comments.summary(true).limit(0)&access_token=${account.accessToken}`;
      const apiRes = await fetch(url);
      const apiData = await apiRes.json();
      
      if (apiRes.ok) {
        posts = (apiData.data || []).map(post => ({
          id: post.id,
          content: post.message || 'No post message',
          createdAt: post.created_time,
          permalink: post.permalink_url || `https://facebook.com/${post.id}`,
          mediaUrl: post.full_picture || '',
          likes: post.likes?.summary?.total_count || 0,
          comments: post.comments?.summary?.total_count || 0
        }));
      } else {
        const message = apiData.error?.message || 'Meta API returned an error fetching posts';
        const isPermissionError = apiData.error?.code === 10;
        console.warn(`Meta Facebook feed access failed for ${account.name}: ${message}`);
        return res.status(apiRes.status || 400).json({ 
          message: isPermissionError
            ? 'Meta denied feed access. Reconnect this Facebook Page after adding pages_read_user_content, and make sure the app has the required Meta permission or app-review access.'
            : message
        });
      }
    } else if (account.platform === 'instagram') {
      const url = `https://graph.facebook.com/v20.0/${account.accountId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&access_token=${account.accessToken}`;
      const apiRes = await fetch(url);
      const apiData = await apiRes.json();

      if (apiRes.ok) {
        posts = (apiData.data || []).map(post => ({
          id: post.id,
          content: post.caption || 'No caption',
          createdAt: post.timestamp,
          permalink: post.permalink || `https://instagram.com/p/${post.id}`,
          mediaUrl: post.media_url || '',
          likes: post.like_count || 0,
          comments: post.comments_count || 0
        }));
      } else {
        console.error('Meta Instagram Media API error:', apiData);
        return res.status(apiRes.status || 400).json({ 
          message: apiData.error?.message || 'Meta API returned an error fetching posts' 
        });
      }
    }

    res.status(200).json(posts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
