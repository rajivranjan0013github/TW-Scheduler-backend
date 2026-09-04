import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import User from '../models/User.js';
import SocialAccount from '../models/SocialAccount.js';
import ScheduledPost from '../models/ScheduledPost.js';
import PublishedPost from '../models/PublishedPost.js';
import PostMetricSnapshot from '../models/PostMetricSnapshot.js';
import PostMetricDailySnapshot from '../models/PostMetricDailySnapshot.js';
import PostInsight from '../models/PostInsight.js';
import Insight from '../models/Insight.js';
import Media from '../models/Media.js';
import CampaignChannel from '../models/CampaignChannel.js';
import { protect } from '../middleware/auth.js';
import { storeRemoteAvatarForUser } from '../services/avatarStorageService.js';

const router = express.Router();

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'fallback_secret', {
    expiresIn: '30d',
  });
};

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// @desc    Auth user / Google Login Simulation & Verification
// @route   POST /api/auth/login
// @access  Public
router.post('/login', async (req, res) => {
  const { credential, accessToken } = req.body;

  if (!credential && !accessToken) {
    return res.status(400).json({ message: 'Missing Google credential token or access token' });
  }

  try {
    let email, name, avatar, googleId;

    if (credential) {
      try {
        const ticket = await client.verifyIdToken({
          idToken: credential,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        email = payload.email;
        name = payload.name;
        avatar = payload.picture;
        googleId = payload.sub;
      } catch (err) {
        console.error('Backend Google Token Verification Error:', err.message);
        return res.status(401).json({ message: 'Invalid Google credential token' });
      }
    } else {
      try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        if (!response.ok) {
          throw new Error(`Google API returned status ${response.status}`);
        }
        const payload = await response.json();
        email = payload.email;
        name = payload.name;
        avatar = payload.picture;
        googleId = payload.sub;
      } catch (err) {
        console.error('Backend Google Access Token Verification Error:', err.message);
        return res.status(401).json({ message: 'Invalid Google access token' });
      }
    }

    const isConnected = getDBStatus();

    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Sandbox login is disabled.' });
    }

    // Connected MongoDB Mode
    let user = await User.findOne({ email });

    if (!user) {
      const userCount = await User.countDocuments();
      user = await User.create({
        email,
        name,
        avatar,
        role: userCount === 0 ? 'owner' : 'editor',
        userType: req.body.userType,
        googleId,
      });
    }

    if (avatar) {
      await storeRemoteAvatarForUser(user, avatar);
    }

    const token = generateToken(user._id);

    res.status(200).json({
      user,
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Auth user / Facebook Login
// @route   POST /api/auth/facebook-login
// @access  Public
router.post('/facebook-login', async (req, res) => {
  const { code, redirectUri } = req.body;

  if (!code || !redirectUri) {
    return res.status(400).json({ message: 'Missing Facebook login code or redirect URI' });
  }

  try {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      return res.status(500).json({ message: 'Facebook login is not configured on the server.' });
    }

    const tokenParams = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    });

    const tokenResponse = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?${tokenParams.toString()}`);
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(401).json({
        message: tokenData.error?.message || 'Invalid Facebook login code',
      });
    }

    const profileParams = new URLSearchParams({
      fields: 'id,name,picture.type(large)',
      access_token: tokenData.access_token,
    });
    const profileResponse = await fetch(`https://graph.facebook.com/v20.0/me?${profileParams.toString()}`);
    const profile = await profileResponse.json();

    if (!profileResponse.ok || !profile.id) {
      return res.status(401).json({
        message: profile.error?.message || 'Failed to read Facebook profile',
      });
    }

    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Sandbox login is disabled.' });
    }

    const fallbackEmail = `facebook_${profile.id}@facebook.local`;
    const email = profile.email || fallbackEmail;

    let user = await User.findOne({
      $or: [
        { facebookId: profile.id },
        { email },
      ],
    });

    const facebookAvatar = profile.picture?.data?.url || '';

    if (!user) {
      const userCount = await User.countDocuments();
      user = await User.create({
        email,
        name: profile.name || email,
        avatar: facebookAvatar,
        role: userCount === 0 ? 'owner' : 'editor',
        userType: req.body.userType,
        facebookId: profile.id,
      });
    } else {
      user.facebookId = user.facebookId || profile.id;
      user.name = user.name || profile.name || email;
      user.avatar = user.avatar || facebookAvatar;
      await user.save();
    }

    if (facebookAvatar) {
      await storeRemoteAvatarForUser(user, facebookAvatar);
    }

    const token = generateToken(user._id);

    res.status(200).json({
      user,
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
router.get('/me', protect, (req, res) => {
  res.status(200).json(req.user);
});

// @desc    Update current user details
// @route   PUT /api/auth/me
// @access  Private
router.put('/me', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Profile updates are disabled.' });
    }

    const { name, avatar, userType } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (name) user.name = name;
    if (avatar) {
      user.avatar = avatar;
      await storeRemoteAvatarForUser(user, avatar);
    }
    if (userType) user.userType = userType;

    await user.save();
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Helper to parse and verify Meta signed_request
const parseMetaSignedRequest = (signedRequest, appSecret) => {
  if (!signedRequest || typeof signedRequest !== 'string') return null;
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;

  const [encodedSig, encodedPayload] = parts;
  const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex');
  const expectedSig = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest('hex');

  if (sig !== expectedSig) {
    return null;
  }

  const payloadJson = Buffer.from(encodedPayload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(payloadJson);
};

// @desc    Delete user account and all connected resources (Cascade Deletion)
// @route   DELETE /api/auth/me
// @access  Private
router.delete('/me', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Account deletion is disabled.' });
    }

    const userId = req.user._id;

    // Find all social accounts to cascade metric & post deletion
    const userAccounts = await SocialAccount.find({ userId }).select('_id');
    const accountIds = userAccounts.map(a => a._id);

    // Wipe all platform data, posts, metrics, media, channels, and profile
    await Promise.all([
      ScheduledPost.deleteMany({ userId }),
      PublishedPost.deleteMany({ $or: [{ userId }, { accountId: { $in: accountIds } }] }),
      PostMetricSnapshot.deleteMany({ accountId: { $in: accountIds } }),
      PostMetricDailySnapshot.deleteMany({ accountId: { $in: accountIds } }),
      PostInsight.deleteMany({ accountId: { $in: accountIds } }),
      Insight.deleteMany({ accountId: { $in: accountIds } }),
      Media.deleteMany({ userId }),
      CampaignChannel.deleteMany({ userId }),
      SocialAccount.deleteMany({ userId }),
      User.deleteOne({ _id: userId }),
    ]);

    res.status(200).json({ message: 'Account and all connected data deleted successfully.' });
  } catch (error) {
    console.error('Account deletion error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// @desc    Meta Data Deletion Callback (signed_request from Facebook Settings)
// @route   POST /api/auth/meta-data-deletion
// @access  Public
router.post('/meta-data-deletion', async (req, res) => {
  try {
    const signedRequest = req.body?.signed_request;
    const appSecret = process.env.META_APP_SECRET;

    if (!signedRequest || !appSecret) {
      return res.status(400).json({ message: 'Missing signed_request or app secret configuration.' });
    }

    const data = parseMetaSignedRequest(signedRequest, appSecret);
    if (!data || !data.user_id) {
      return res.status(400).json({ message: 'Invalid signed_request signature or payload.' });
    }

    const fbUserId = String(data.user_id);
    const confirmationCode = `del_${fbUserId}_${Date.now()}`;

    // Find user and associated accounts linked to this Facebook ID
    const user = await User.findOne({ facebookId: fbUserId });
    const socialAccounts = await SocialAccount.find({
      $or: [
        { accountId: fbUserId },
        ...(user ? [{ userId: user._id }] : []),
      ],
    });
    const accountIds = socialAccounts.map((a) => a._id);

    // Cascade wipe all platform data
    await Promise.all([
      SocialAccount.deleteMany({ _id: { $in: accountIds } }),
      PublishedPost.deleteMany({ accountId: { $in: accountIds } }),
      ScheduledPost.deleteMany({ socialAccountIds: { $in: accountIds } }),
      PostMetricSnapshot.deleteMany({ accountId: { $in: accountIds } }),
      PostMetricDailySnapshot.deleteMany({ accountId: { $in: accountIds } }),
      PostInsight.deleteMany({ accountId: { $in: accountIds } }),
      Insight.deleteMany({ accountId: { $in: accountIds } }),
      ...(user ? [User.deleteOne({ _id: user._id }), Media.deleteMany({ userId: user._id })] : []),
    ]);

    const statusUrl = `https://theeasypost.com/data-deletion?code=${confirmationCode}`;
    return res.status(200).json({
      url: statusUrl,
      confirmation_code: confirmationCode,
    });
  } catch (err) {
    console.error('❌ Meta data deletion error:', err.message);
    return res.status(500).json({ message: 'Failed to process data deletion request.' });
  }
});

export default router;
