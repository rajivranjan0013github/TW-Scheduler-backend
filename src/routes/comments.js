import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// @desc    Get comments for connected accounts
// @route   GET /api/comments
// @access  Private
router.get('/', protect, async (req, res) => {
  const { accountId } = req.query;
  try {
    let list = [...mockStore.comments];
    if (accountId) {
      list = list.filter(c => c.accountId === accountId);
    }
    // Sort newest first
    list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.status(200).json(list);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Reply to a comment
// @route   POST /api/comments/:id/reply
// @access  Private (Owner, Admin, Editor)
router.post('/:id/reply', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ message: 'Reply text is required' });
  }

  try {
    const comment = mockStore.comments.find(c => c._id === id);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    // Add reply
    const newReply = {
      text,
      username: req.user.role === 'owner' ? 'travel_diaries_official' : 'admin_moderator',
      timestamp: new Date()
    };

    comment.replies.push(newReply);
    comment.isReplied = true;

    res.status(200).json(comment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
