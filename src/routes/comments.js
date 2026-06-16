import express from 'express';
import { getDBStatus } from '../config/db.js';
import SocialAccount from '../models/SocialAccount.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// In-memory cache to avoid hammering Meta APIs on every page load
const commentCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Fetch comments for a single Instagram post
 */
const fetchInstagramPostComments = async (postId, accessToken, authProvider) => {
  const graphHost = authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const url = `https://${graphHost}/v20.0/${postId}/comments?fields=id,text,username,timestamp,replies{id,text,username,timestamp}&access_token=${accessToken}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      console.warn(`⚠️ Failed to fetch comments for IG post ${postId}:`, data.error?.message);
      return [];
    }

    return (data.data || []).map(comment => ({
      _id: comment.id,
      commentId: comment.id,
      text: comment.text,
      username: comment.username || 'instagram_user',
      timestamp: comment.timestamp,
      isReplied: comment.replies?.data?.length > 0,
      replies: (comment.replies?.data || []).map(reply => ({
        text: reply.text,
        username: reply.username || 'instagram_user',
        timestamp: reply.timestamp,
      })),
    }));
  } catch (error) {
    console.warn(`⚠️ Error fetching IG comments for post ${postId}:`, error.message);
    return [];
  }
};

/**
 * Fetch comments for a single Facebook post
 */
const fetchFacebookPostComments = async (postId, accessToken) => {
  const url = `https://graph.facebook.com/v20.0/${postId}/comments?fields=id,message,from,created_time&order=reverse_chronological&access_token=${accessToken}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      console.warn(`⚠️ Failed to fetch comments for FB post ${postId}:`, data.error?.message);
      return [];
    }

    return (data.data || []).map(comment => ({
      _id: comment.id,
      commentId: comment.id,
      text: comment.message || '',
      username: comment.from?.name || 'Facebook User',
      timestamp: comment.created_time,
      isReplied: false, // We'd need a sub-request to check; skip for now
      replies: [],
    }));
  } catch (error) {
    console.warn(`⚠️ Error fetching FB comments for post ${postId}:`, error.message);
    return [];
  }
};

/**
 * Fetch recent posts for an account, then fetch comments for each post
 */
const fetchCommentsForAccount = async (account) => {
  const { accountId, accessToken, platform, authProvider } = account;
  const graphHost = (platform === 'instagram' && authProvider === 'instagram') 
    ? 'graph.instagram.com' 
    : 'graph.facebook.com';

  let posts = [];

  try {
    if (platform === 'instagram') {
      const url = `https://${graphHost}/v20.0/${accountId}/media?fields=id,caption,timestamp&limit=10&access_token=${accessToken}`;
      const res = await fetch(url);
      const data = await res.json();

      if (res.ok && data.data) {
        posts = data.data;
      } else {
        console.warn(`⚠️ Failed to fetch IG media for ${account.name}:`, data.error?.message);
        return [];
      }
    } else if (platform === 'facebook') {
      const url = `https://graph.facebook.com/v20.0/${accountId}/published_posts?fields=id,message,created_time&limit=10&access_token=${accessToken}`;
      const res = await fetch(url);
      const data = await res.json();

      if (res.ok && data.data) {
        posts = data.data;
      } else {
        console.warn(`⚠️ Failed to fetch FB posts for ${account.name}:`, data.error?.message);
        return [];
      }
    }
  } catch (error) {
    console.warn(`⚠️ Error fetching posts for ${account.name}:`, error.message);
    return [];
  }

  // Fetch comments for each post in parallel
  const allComments = [];
  const commentPromises = posts.map(async (post) => {
    let comments = [];
    if (platform === 'instagram') {
      comments = await fetchInstagramPostComments(post.id, accessToken, authProvider);
    } else if (platform === 'facebook') {
      comments = await fetchFacebookPostComments(post.id, accessToken);
    }

    // Tag each comment with account info and post context
    return comments.map(c => ({
      ...c,
      accountId: account.accountId,
      accountDbId: account._id,
      platform,
      postId: post.id,
      postCaption: post.caption || post.message || '',
    }));
  });

  const results = await Promise.all(commentPromises);
  for (const batch of results) {
    allComments.push(...batch);
  }

  return allComments;
};

// @desc    Get real comments from Meta API for all connected accounts
// @route   GET /api/comments
// @access  Private
router.get('/', protect, async (req, res) => {
  const { accountId } = req.query;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Comments require connected accounts.' });
    }

    // Build query for user's accounts
    const query = { userId: req.user._id, isConnected: true };
    if (accountId) {
      query.accountId = accountId;
    }

    console.log(`💬 [Comments] Fetching for user: ${req.user._id}, filter: ${accountId || 'all'}`);

    const accounts = await SocialAccount.find(query);
    console.log(`💬 [Comments] Found ${accounts.length} connected accounts for this user`);
    
    if (accounts.length === 0) {
      console.log(`💬 [Comments] No accounts found — returning empty`);
      return res.status(200).json([]);
    }

    // Check cache first
    const cacheKey = `${req.user._id}_${accountId || 'all'}`;
    const cached = commentCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      console.log(`💬 [Comments] Returning ${cached.data.length} cached comments`);
      return res.status(200).json(cached.data);
    }

    // Filter out mock accounts
    const realAccounts = accounts.filter(a => !a.accessToken?.startsWith('mock-'));
    console.log(`💬 [Comments] ${realAccounts.length} real accounts (${accounts.length - realAccounts.length} mock skipped)`);
    
    if (realAccounts.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch comments for all accounts in parallel
    const accountPromises = realAccounts.map(account => {
      console.log(`💬 [Comments] Fetching for ${account.platform}:${account.name} (${account.accountId})`);
      return fetchCommentsForAccount(account);
    });
    const results = await Promise.all(accountPromises);
    
    // Flatten and sort by timestamp (newest first)
    const allComments = results.flat();
    allComments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    console.log(`💬 [Comments] Total comments fetched: ${allComments.length}`);

    // Cache the result
    commentCache.set(cacheKey, { data: allComments, timestamp: Date.now() });

    res.status(200).json(allComments);
  } catch (error) {
    console.error('❌ Error fetching comments:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// @desc    Reply to a comment via Meta API
// @route   POST /api/comments/:id/reply
// @access  Private (Owner, Admin, Editor)
router.post('/:id/reply', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params; // Meta comment ID
  const { text, accountDbId } = req.body;

  if (!text) {
    return res.status(400).json({ message: 'Reply text is required' });
  }

  if (!accountDbId) {
    return res.status(400).json({ message: 'accountDbId is required to identify which account to reply from' });
  }

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected.' });
    }

    // Look up the social account (verify it belongs to this user)
    const account = await SocialAccount.findOne({ _id: accountDbId, userId: req.user._id });
    if (!account) {
      return res.status(404).json({ message: 'Social account not found' });
    }

    const { accessToken, platform, authProvider } = account;
    let replyData = null;

    if (platform === 'instagram') {
      const graphHost = authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
      const url = `https://${graphHost}/v20.0/${id}/replies`;

      const params = new URLSearchParams();
      params.append('message', text);
      params.append('access_token', accessToken);

      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      replyData = await apiRes.json();

      if (!apiRes.ok) {
        console.error('❌ Instagram reply failed:', replyData);
        return res.status(apiRes.status || 400).json({ 
          message: replyData.error?.message || 'Failed to reply on Instagram' 
        });
      }
    } else if (platform === 'facebook') {
      const url = `https://graph.facebook.com/v20.0/${id}/comments`;

      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          access_token: accessToken,
        }),
      });
      replyData = await apiRes.json();

      if (!apiRes.ok) {
        console.error('❌ Facebook reply failed:', replyData);
        return res.status(apiRes.status || 400).json({ 
          message: replyData.error?.message || 'Failed to reply on Facebook' 
        });
      }
    }

    // Invalidate cache after replying
    for (const [key] of commentCache) {
      if (key.startsWith(req.user._id.toString())) {
        commentCache.delete(key);
      }
    }

    console.log(`✅ Reply posted successfully on ${platform}:`, replyData);
    res.status(200).json({ 
      message: 'Reply posted successfully',
      replyId: replyData?.id,
      platform,
    });
  } catch (error) {
    console.error('❌ Error replying to comment:', error.message);
    res.status(500).json({ message: error.message });
  }
});

export default router;
