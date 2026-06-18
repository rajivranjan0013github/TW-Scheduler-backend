import express from 'express';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import User from '../models/User.js';
import SocialAccount from '../models/SocialAccount.js';
import { protect } from '../middleware/auth.js';

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
      user = await User.create({
        email,
        name,
        avatar,
        role: 'owner',
        googleId,
      });
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
    if (avatar) user.avatar = avatar;

    await user.save();
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete user account and all connected resources
// @route   DELETE /api/auth/me
// @access  Private
router.delete('/me', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(503).json({ message: 'Database disconnected. Account deletion is disabled.' });
    }

    const userId = req.user._id;

    // Wipe connected social integrations and the user profile
    await Promise.all([
      SocialAccount.deleteMany({ userId }),
      User.deleteOne({ _id: userId })
    ]);

    res.status(200).json({ message: 'Account and connected integrations deleted successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
