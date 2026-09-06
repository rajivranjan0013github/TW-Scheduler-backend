import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import User from '../models/User.js';
import SocialAccount from '../models/SocialAccount.js';
import { protect } from '../middleware/auth.js';
import { storeRemoteAvatarForUser } from '../services/avatarStorageService.js';
import { purgeSocialAccounts, purgeUserData } from '../services/dataPurgeService.js';
import DataDeletionRequest, { hashDeletionCode } from '../models/DataDeletionRequest.js';

const router = express.Router();

const generateToken = (id) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is required.');
  }
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// @desc    Authenticate a user with Google or an explicitly provisioned email account
// @route   POST /api/auth/login
// @access  Public
router.post('/login', async (req, res) => {
  const { credential, accessToken, email: inputEmail, password: inputPassword } = req.body;

  if (!credential && !accessToken && (!inputEmail || !inputPassword)) {
    return res.status(400).json({ message: 'Missing login credentials. Provide Google token or email and password.' });
  }

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Sandbox login is disabled.' });
    }

    // Direct email authentication. Reviewer accounts must be provisioned explicitly;
    // this route never creates accounts or accepts fallback passwords.
    if (inputEmail && inputPassword) {
      const normalizedEmail = inputEmail.toLowerCase().trim();
      const user = await User.findOne({ email: normalizedEmail }).select('+password');

      if (!user || !user.password) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }

      const isMatch = await bcrypt.compare(inputPassword, user.password);
      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }

      const token = generateToken(user._id);
      return res.status(200).json({ user, token });
    }

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

    // Connected MongoDB Mode
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        email,
        name,
        avatar,
        role: 'editor',
        userType: 'account_handler',
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

    const { name, avatar } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (name) user.name = name;
    if (avatar) {
      user.avatar = avatar;
      await storeRemoteAvatarForUser(user, avatar);
    }
    await user.save();
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Helper to parse and verify Meta signed_request
export const parseMetaSignedRequest = (signedRequest, appSecret) => {
  if (!signedRequest || typeof signedRequest !== 'string' || !appSecret) return null;
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;

  const [encodedSig, encodedPayload] = parts;
  try {
    const sig = Buffer.from(encodedSig, 'base64url');
    const expectedSig = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest();

    if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
      return null;
    }

    const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
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

    await purgeUserData(req.user._id, { revokeProviderAccess: true });

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
    const confirmationCode = crypto.randomBytes(24).toString('hex');

    // Find user and associated accounts linked to this Facebook ID
    const user = await User.findOne({ facebookId: fbUserId });
    const socialAccounts = await SocialAccount.find({
      platform: { $in: ['facebook', 'instagram'] },
      $or: [
        { accountId: fbUserId },
        { 'metadata.facebookUserId': fbUserId },
        ...(user ? [{ userId: user._id }] : []),
      ],
    });
    const accountIds = socialAccounts.map((a) => a._id);

    if (user) {
      await purgeUserData(user._id, { revokeProviderAccess: true });
    } else {
      await purgeSocialAccounts(accountIds, { revokeProviderAccess: true });
    }

    await DataDeletionRequest.create({
      confirmationCodeHash: hashDeletionCode(confirmationCode),
      provider: 'meta',
      status: 'completed',
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });

    const statusUrl = `https://thousandpost.com/data-deletion?code=${confirmationCode}`;
    return res.status(200).json({
      url: statusUrl,
      confirmation_code: confirmationCode,
    });
  } catch (err) {
    console.error('❌ Meta data deletion error:', err.message);
    return res.status(500).json({ message: 'Failed to process data deletion request.' });
  }
});

// @desc    Meta Deauthorization Callback (signed_request when user removes app in Facebook Settings)
// @route   POST /api/auth/meta-deauthorize
// @access  Public
router.post('/meta-deauthorize', async (req, res) => {
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
    const user = await User.findOne({ facebookId: fbUserId });
    const socialAccounts = await SocialAccount.find({
      platform: { $in: ['facebook', 'instagram'] },
      $or: [
        { accountId: fbUserId },
        { 'metadata.facebookUserId': fbUserId },
        ...(user ? [{ userId: user._id }] : []),
      ],
    });

    const accountIds = socialAccounts.map((a) => a._id);
    await purgeSocialAccounts(accountIds, { revokeProviderAccess: false });

    return res.status(200).json({ message: 'Deauthorization processed successfully.' });
  } catch (err) {
    console.error('❌ Meta deauthorize error:', err.message);
    return res.status(500).json({ message: 'Failed to process deauthorization callback.' });
  }
});

// @desc    Check the status of a Meta data-deletion request
// @route   GET /api/auth/meta-data-deletion/status/:code
// @access  Public
router.get('/meta-data-deletion/status/:code', async (req, res) => {
  const code = String(req.params.code || '');
  if (!/^[a-f0-9]{48}$/i.test(code)) {
    return res.status(404).json({ message: 'Deletion request not found.' });
  }

  const request = await DataDeletionRequest.findOne({
    confirmationCodeHash: hashDeletionCode(code),
    expiresAt: { $gt: new Date() },
  }).select('status completedAt').lean();

  if (!request) {
    return res.status(404).json({ message: 'Deletion request not found.' });
  }
  return res.status(200).json({ status: request.status, completedAt: request.completedAt });
});

export default router;
