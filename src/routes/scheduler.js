import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// @desc    Get all scheduled and published posts
// @route   GET /api/scheduler
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      // Sort in-memory posts by date
      const sorted = [...mockStore.scheduledPosts].sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      return res.status(200).json(sorted);
    }

    const posts = await ScheduledPost.find()
      .populate('socialAccountIds')
      .populate('mediaIds')
      .sort({ scheduledAt: 1 });
    
    res.status(200).json(posts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create a scheduled post
// @route   POST /api/scheduler
// @access  Private (Owner, Admin, Editor)
router.post('/', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { socialAccountIds, mediaIds, caption, scheduledAt, platformSpecifics } = req.body;

  try {
    const isConnected = getDBStatus();
    const scheduledDate = new Date(scheduledAt);

    if (!isConnected) {
      const newPost = {
        _id: `sp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        socialAccountIds,
        mediaIds,
        caption: caption || '',
        scheduledAt: scheduledDate,
        status: 'scheduled',
        platformSpecifics: platformSpecifics || { type: 'reels' },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockStore.scheduledPosts.push(newPost);
      return res.status(201).json(newPost);
    }

    const post = await ScheduledPost.create({
      socialAccountIds,
      mediaIds,
      caption,
      scheduledAt: scheduledDate,
      platformSpecifics: platformSpecifics || { type: 'reels' },
    });

    res.status(201).json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Bulk Schedule posts sequentially
// @route   POST /api/scheduler/bulk
// @access  Private (Owner, Admin, Editor)
router.post('/bulk', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { socialAccountIds, mediaIds, caption, startDate, intervalHours, type } = req.body;

  if (!socialAccountIds || !mediaIds || mediaIds.length === 0) {
    return res.status(400).json({ message: 'Must select social accounts and at least one media file' });
  }

  try {
    const isConnected = getDBStatus();
    const baseDate = new Date(startDate || Date.now());
    const intervalMs = (parseFloat(intervalHours) || 2) * 60 * 60 * 1000;
    const createdPosts = [];

    // For bulk scheduling: we loop through the social accounts, and for each account
    // we sequence the media files with the specified hour gap.
    // e.g. 5 accounts, 50 reels = 250 scheduled posts
    let index = 0;
    for (const accountId of socialAccountIds) {
      let currentScheduleTime = new Date(baseDate.getTime());
      
      for (const mediaId of mediaIds) {
        const scheduledTime = new Date(currentScheduleTime.getTime());
        
        if (!isConnected) {
          const newPost = {
            _id: `sp_bulk_${Date.now()}_${index++}`,
            socialAccountIds: [accountId],
            mediaIds: [mediaId],
            caption: caption || '',
            scheduledAt: scheduledTime,
            status: 'scheduled',
            platformSpecifics: { type: type || 'reels' },
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockStore.scheduledPosts.push(newPost);
          createdPosts.push(newPost);
        } else {
          const post = await ScheduledPost.create({
            socialAccountIds: [accountId],
            mediaIds: [mediaId],
            caption: caption || '',
            scheduledAt: scheduledTime,
            platformSpecifics: { type: type || 'reels' },
          });
          createdPosts.push(post);
        }

        // Increment schedule time for next media file on this account
        currentScheduleTime = new Date(currentScheduleTime.getTime() + intervalMs);
      }
    }

    res.status(201).json({
      message: `Successfully scheduled ${createdPosts.length} posts.`,
      postsCount: createdPosts.length,
      posts: createdPosts
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Update/Reschedule a post (supports Drag & Drop)
// @route   PUT /api/scheduler/:id
// @access  Private (Owner, Admin, Editor)
router.put('/:id', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;
  const { scheduledAt, caption, mediaIds, socialAccountIds, platformSpecifics, status } = req.body;

  try {
    const isConnected = getDBStatus();

    if (!isConnected) {
      const post = mockStore.scheduledPosts.find(p => p._id === id);
      if (!post) {
        return res.status(404).json({ message: 'Post not found' });
      }

      if (scheduledAt) post.scheduledAt = new Date(scheduledAt);
      if (caption !== undefined) post.caption = caption;
      if (mediaIds) post.mediaIds = mediaIds;
      if (socialAccountIds) post.socialAccountIds = socialAccountIds;
      if (platformSpecifics) post.platformSpecifics = platformSpecifics;
      if (status) post.status = status;
      post.updatedAt = new Date();

      return res.status(200).json(post);
    }

    const post = await ScheduledPost.findById(id);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    if (scheduledAt) post.scheduledAt = new Date(scheduledAt);
    if (caption !== undefined) post.caption = caption;
    if (mediaIds) post.mediaIds = mediaIds;
    if (socialAccountIds) post.socialAccountIds = socialAccountIds;
    if (platformSpecifics) post.platformSpecifics = platformSpecifics;
    if (status) post.status = status;
    
    await post.save();
    
    const populated = await ScheduledPost.findById(id)
      .populate('socialAccountIds')
      .populate('mediaIds');
      
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete/Cancel a scheduled post
// @route   DELETE /api/scheduler/:id
// @access  Private (Owner, Admin, Editor)
router.delete('/:id', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();

    if (!isConnected) {
      const index = mockStore.scheduledPosts.findIndex(p => p._id === id);
      if (index === -1) {
        return res.status(404).json({ message: 'Post not found' });
      }
      mockStore.scheduledPosts.splice(index, 1);
      return res.status(200).json({ message: 'Scheduled post removed successfully' });
    }

    const post = await ScheduledPost.findById(id);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    await ScheduledPost.findByIdAndDelete(id);
    res.status(200).json({ message: 'Scheduled post removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
