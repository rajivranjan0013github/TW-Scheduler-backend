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

const ADMIN_PREVIEW_ROLES = ['owner', 'admin'];

// Resolve an admin preview to the same user object the handler routes normally receive.
export const resolveHandlerPreview = async (req, res, next) => {
  const previewUserId = String(req.get('x-handler-preview-user-id') || '').trim();
  if (!previewUserId) return next();

  const authenticatedUser = req.user;
  const canPreview = ADMIN_PREVIEW_ROLES.includes(authenticatedUser?.role)
    && authenticatedUser?.userType !== 'account_handler';
  if (!canPreview) {
    return res.status(403).json({ message: 'Only an administrator can preview a handler account.' });
  }

  try {
    const isConnected = getDBStatus();
    const previewUser = isConnected
      ? await User.findById(previewUserId).select('-password')
      : mockStore.users.find(user => String(user._id) === previewUserId);

    if (!previewUser) {
      return res.status(404).json({ message: 'Handler account not found.' });
    }
    if (previewUser.userType !== 'account_handler') {
      return res.status(400).json({ message: 'The selected user is not an account handler.' });
    }

    req.authenticatedUser = authenticatedUser;
    req.user = previewUser;
    req.isHandlerPreview = true;
    return next();
  } catch (error) {
    return res.status(400).json({ message: 'Invalid handler preview user.' });
  }
};

// Role authorization middleware
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
    }

    next();
  };
};
