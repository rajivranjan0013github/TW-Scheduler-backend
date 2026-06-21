import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import Media from '../models/Media.js';
import SocialAccount from '../models/SocialAccount.js';
import { protect, authorize } from '../middleware/auth.js';
import { addPostToQueue, removePostFromQueue } from '../queues/publisherQueue.js';

const router = express.Router();
const ADMIN_ROLES = ['owner', 'admin'];

const getScopedUserId = (req) => {
  if (ADMIN_ROLES.includes(req.user?.role) && req.query.userId) {
    return req.query.userId;
  }
  return req.user._id;
};

const getActiveCampaignId = (req) => req.query.campaignId || req.body?.campaignId || null;

const requireCampaignId = (req, res) => {
  const campaignId = getActiveCampaignId(req);
  if (!campaignId) {
    res.status(400).json({ message: 'Campaign is required.' });
    return null;
  }
  return campaignId;
};

const idsToStrings = (items = []) => items.map((item) => String(item?._id || item));

const withPostCaption = (platformSpecifics, postCaption, type) => {
  const nextSpecifics = platformSpecifics
    ? { ...platformSpecifics }
    : { type: type || 'reels' };

  if (nextSpecifics.youtube) {
    nextSpecifics.youtube = {
      ...nextSpecifics.youtube,
      description: postCaption,
    };
  }

  return nextSpecifics;
};

const validateSchedulingAccess = async ({ campaignId, socialAccountIds, mediaIds, requireEveryAccount = true }) => {
  const accountIds = idsToStrings(socialAccountIds);
  const mediaIdList = idsToStrings(mediaIds);

  if (accountIds.length === 0 || mediaIdList.length === 0) {
    return { ok: false, message: 'Must select publishing channels and at least one media file' };
  }

  const [accounts, mediaItems] = await Promise.all([
    SocialAccount.find({ _id: { $in: accountIds }, campaignId, isConnected: true }).select('_id'),
    Media.find({ _id: { $in: mediaIdList }, campaignId }).select('_id socialAccountIds'),
  ]);

  if (accounts.length !== accountIds.length) {
    return { ok: false, message: 'One or more selected publishing channels are not connected.' };
  }
  if (mediaItems.length !== mediaIdList.length) {
    return { ok: false, message: 'One or more selected media assets were not found.' };
  }

  return { ok: true };
};

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

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const posts = await ScheduledPost.find({ campaignId })
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
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const scheduledDate = new Date(scheduledAt);
    let postCaption = caption || '';

    if (!isConnected) {
      if (!postCaption && mediaIds?.[0]) {
        const mediaItem = mockStore.media.find(m => String(m._id) === String(mediaIds[0]));
        postCaption = mediaItem?.caption || '';
      }
      const newPost = {
        _id: `sp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        socialAccountIds,
        mediaIds,
        caption: postCaption,
        scheduledAt: scheduledDate,
        status: 'scheduled',
        platformSpecifics: withPostCaption(platformSpecifics, postCaption, platformSpecifics?.type || 'reels'),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockStore.scheduledPosts.push(newPost);
      return res.status(201).json(newPost);
    }

    const access = await validateSchedulingAccess({
      campaignId,
      socialAccountIds,
      mediaIds,
      requireEveryAccount: true,
    });
    if (!access.ok) {
      return res.status(400).json({ message: access.message });
    }

    if (!postCaption && mediaIds?.[0]) {
      const mediaItem = await Media.findOne({ _id: mediaIds[0], campaignId }).select('caption');
      postCaption = mediaItem?.caption || '';
    }

    const post = await ScheduledPost.create({
      userId: req.user._id,
      campaignId,
      socialAccountIds,
      mediaIds,
      caption: postCaption,
      scheduledAt: scheduledDate,
      platformSpecifics: withPostCaption(platformSpecifics, postCaption, platformSpecifics?.type || 'reels'),
    });
    await addPostToQueue(post);

    res.status(201).json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Bulk Schedule posts sequentially
// @route   POST /api/scheduler/bulk
// @access  Private (Owner, Admin, Editor)
router.post('/bulk', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { socialAccountIds, mediaIds, caption, startDate, intervalHours, type, platformSpecifics } = req.body;

  if (!socialAccountIds || !mediaIds || mediaIds.length === 0) {
    return res.status(400).json({ message: 'Must select publishing channels and at least one media file' });
  }

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const baseDate = new Date(startDate || Date.now());
    const intervalMs = (parseFloat(intervalHours) || 2) * 60 * 60 * 1000;
    const createdPosts = [];
    const mediaCaptionMap = new Map();

    if (isConnected) {
      const access = await validateSchedulingAccess({
        campaignId,
        socialAccountIds,
        mediaIds,
        requireEveryAccount: true,
      });
      if (!access.ok) {
        return res.status(400).json({ message: access.message });
      }

      const mediaItems = await Media.find({
        _id: { $in: idsToStrings(mediaIds) },
        campaignId,
      }).select('_id caption');

      mediaItems.forEach((mediaItem) => {
        mediaCaptionMap.set(String(mediaItem._id), mediaItem.caption || '');
      });
    } else {
      mockStore.media.forEach((mediaItem) => {
        mediaCaptionMap.set(String(mediaItem._id), mediaItem.caption || '');
      });
    }

    // For bulk scheduling: we loop through the publishing channels, and for each channel
    // we sequence the media files with the specified hour gap.
    // e.g. 5 accounts, 50 reels = 250 scheduled posts
    let index = 0;
    for (const accountId of socialAccountIds) {
      let currentScheduleTime = new Date(baseDate.getTime());
      
      for (const mediaId of mediaIds) {
        const scheduledTime = new Date(currentScheduleTime.getTime());
        const mediaCaption = mediaCaptionMap.get(String(mediaId)) || '';
        const postCaption = mediaCaption || caption || '';
        const postPlatformSpecifics = withPostCaption(platformSpecifics, postCaption, type);
        
        if (!isConnected) {
          const newPost = {
            _id: `sp_bulk_${Date.now()}_${index++}`,
            socialAccountIds: [accountId],
            mediaIds: [mediaId],
            caption: postCaption,
            scheduledAt: scheduledTime,
            status: 'scheduled',
            platformSpecifics: postPlatformSpecifics,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockStore.scheduledPosts.push(newPost);
          createdPosts.push(newPost);
        } else {
          const post = await ScheduledPost.create({
            userId: req.user._id,
            campaignId,
            socialAccountIds: [accountId],
            mediaIds: [mediaId],
            caption: postCaption,
            scheduledAt: scheduledTime,
            platformSpecifics: postPlatformSpecifics,
          });
          await addPostToQueue(post);
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
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;

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

    const post = await ScheduledPost.findOne({ _id: id, campaignId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    if (mediaIds || socialAccountIds) {
      const access = await validateSchedulingAccess({
        campaignId,
        socialAccountIds: socialAccountIds || post.socialAccountIds,
        mediaIds: mediaIds || post.mediaIds,
        requireEveryAccount: true,
      });
      if (!access.ok) {
        return res.status(400).json({ message: access.message });
      }
    }

    if (scheduledAt) post.scheduledAt = new Date(scheduledAt);
    if (caption !== undefined) post.caption = caption;
    if (mediaIds) post.mediaIds = mediaIds;
    if (socialAccountIds) post.socialAccountIds = socialAccountIds;
    if (platformSpecifics) post.platformSpecifics = platformSpecifics;
    if (status) post.status = status;
    
    await post.save();

    await removePostFromQueue(post._id);
    if (post.status === 'scheduled') {
      await addPostToQueue(post);
    }
    
    const populated = await ScheduledPost.findOne({ _id: id, campaignId })
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
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;

    if (!isConnected) {
      const index = mockStore.scheduledPosts.findIndex(p => p._id === id);
      if (index === -1) {
        return res.status(404).json({ message: 'Post not found' });
      }
      mockStore.scheduledPosts.splice(index, 1);
      return res.status(200).json({ message: 'Scheduled post removed successfully' });
    }

    const post = await ScheduledPost.findOne({ _id: id, campaignId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    await removePostFromQueue(post._id);
    await ScheduledPost.deleteOne({ _id: id, campaignId });
    res.status(200).json({ message: 'Scheduled post removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
