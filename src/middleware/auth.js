import jwt from 'jsonwebtoken';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];



      // Handle JWT login
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
      
      const isConnected = getDBStatus();
      if (isConnected) {
        req.user = await User.findById(decoded.id).select('-password');
      } else {
        req.user = mockStore.users.find(u => u._id === decoded.id);
      }

      if (!req.user) {
        return res.status(401).json({ message: 'User not found, authorization denied' });
      }

      next();
    } catch (error) {
      console.error('Auth error:', error.message);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
};

// Role authorization middleware
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized' });
    }
    // All authenticated users have access to all routes
    next();
  };
};
