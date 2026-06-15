import express from 'express';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import User from '../models/User.js';
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
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ message: 'Missing Google credential token' });
  }

  try {
    let email, name, avatar, googleId;

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

export default router;
