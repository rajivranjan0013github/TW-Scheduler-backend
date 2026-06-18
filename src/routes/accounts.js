import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import SocialAccount from '../models/SocialAccount.js';
import { protect, authorize } from '../middleware/auth.js';
import { getYoutubeAuthUrl, exchangeYoutubeCodeForAccount } from '../services/youtubeService.js';

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

    // Compute since and until timestamps for Meta API (last 7 days)
    const sinceDate = new Date();
    sinceDate.setDate(today.getDate() - 7);
    const since = Math.floor(sinceDate.getTime() / 1000);
    const until = Math.floor(Date.now() / 1000);

    const fetchDailyInsightValues = async (account, metricCandidates) => {
      const invalidMetrics = [];
      const graphHost = account.authProvider === 'instagram'
        ? 'graph.instagram.com'
        : 'graph.facebook.com';

      for (const metric of metricCandidates) {
        const url = `https://${graphHost}/v20.0/${account.accountId}/insights?metric=${metric}&period=day&since=${since}&until=${until}&access_token=${account.accessToken}`;
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
    console.log('🤖 [Instagram OAuth] Exchanging authorization code for short-lived token...');

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

    console.log('🤖 [Instagram OAuth] Upgrading token to long-lived token...');
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

    const account = await SocialAccount.findOne({ _id: id, userId: req.user._id });
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const isMock = account.accessToken?.startsWith('mock-');
    if (isMock) {
      return res.status(400).json({ message: 'Mock account feed access is disabled.' });
    }

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
    }

    res.status(200).json(posts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
