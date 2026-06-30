import express from 'express';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import ScheduledPost from '../models/ScheduledPost.js';
import Media from '../models/Media.js';
import Folder from '../models/Folder.js';
import SocialAccount from '../models/SocialAccount.js';
import CampaignChannel from '../models/CampaignChannel.js';
import { protect, authorize } from '../middleware/auth.js';
import { addPostToQueue, removePostFromQueue } from '../queues/publisherQueue.js';
import { normalizeChannelHandle } from '../utils/campaignChannels.js';

const router = express.Router();
const ADMIN_ROLES = ['owner', 'admin'];
const hasAdminAccess = (user) => ADMIN_ROLES.includes(user?.role) && user?.userType !== 'account_handler';

const getScopedUserId = (req) => {
  if (hasAdminAccess(req.user) && req.query.userId) {
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
const validScheduleModes = new Set(['auto', 'manual', 'hybrid']);
const terminalManualStatuses = new Set(['posted_manual', 'published', 'published_auto', 'cancelled']);

const normalizeScheduleMode = (mode) => (
  validScheduleModes.has(mode) ? mode : 'auto'
);

const getInitialStatusForMode = (mode) => (
  mode === 'manual' ? 'manual_ready' : 'scheduled'
);

const shouldQueuePost = (post) => (
  ['auto', 'hybrid'].includes(post.scheduleMode || 'auto') && post.status === 'scheduled'
);

const getUniqueIds = (items = []) => (
  [...new Set(idsToStrings(items).filter(Boolean))]
);

const activeQueueStatuses = ['scheduled', 'manual_ready', 'downloaded', 'publishing'];

const canAccessManualPost = async (post, user) => {
  if (!post || !user) return false;
  if (hasAdminAccess(user)) return true;
  if (String(post.userId) === String(user._id)) return true;

  const postAccountIds = idsToStrings(post.socialAccountIds);
  if (postAccountIds.length > 0) {
    const ownedAccount = await SocialAccount.exists({
      _id: { $in: postAccountIds },
      userId: user._id,
    });
    if (ownedAccount) return true;
  }

  const postChannelIds = idsToStrings(post.campaignChannelIds);
  if (postChannelIds.length === 0) return false;
  const userEmail = (user.email || '').trim().toLowerCase();
  const assignedChannel = await CampaignChannel.exists({
    _id: { $in: postChannelIds },
    $or: [
      { assignedHandlerUserId: user._id },
      ...(userEmail ? [{ assignedHandlerEmail: userEmail }] : []),
    ],
  });

  return Boolean(assignedChannel);
};

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

const getAccountMatchHandles = (account = {}) => (
  [
    normalizeChannelHandle(account.username),
    normalizeChannelHandle(account.name),
    normalizeChannelHandle(account.accountId),
  ].filter(Boolean)
);

const normalizeChannelTargets = ({ channelTargets = [], socialAccountIds = [], campaignChannelIds = [] } = {}) => {
  const normalizedTargets = channelTargets
    .map((target) => ({
      socialAccountId: target?.socialAccountId || null,
      campaignChannelId: target?.campaignChannelId || null,
    }))
    .filter((target) => target.socialAccountId || target.campaignChannelId);

  if (normalizedTargets.length > 0) return normalizedTargets;

  const accountIds = getUniqueIds(socialAccountIds);
  const channelIds = getUniqueIds(campaignChannelIds);
  if (accountIds.length > 0) {
    return accountIds.map((accountId, index) => ({
      socialAccountId: accountId,
      campaignChannelId: channelIds[index] || null,
    }));
  }

  return channelIds.map((channelId) => ({
    socialAccountId: null,
    campaignChannelId: channelId,
  }));
};

const validateSchedulingAccess = async ({ campaignId, socialAccountIds, campaignChannelIds, channelTargets, mediaIds, allowDisconnectedAccounts = false }) => {
  const accountIds = idsToStrings(socialAccountIds);
  const channelIds = idsToStrings(campaignChannelIds);
  const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });
  const mediaIdList = idsToStrings(mediaIds);

  if (targets.length === 0 || mediaIdList.length === 0) {
    return { ok: false, message: 'Must select publishing channels and at least one media file' };
  }

  const mediaItems = await Media.find({ _id: { $in: mediaIdList }, campaignId }).select('_id socialAccountIds');
  if (mediaItems.length !== mediaIdList.length) {
    return { ok: false, message: 'One or more selected media assets were not found.' };
  }

  if (!allowDisconnectedAccounts) {
    if (accountIds.length === 0) {
      return { ok: false, message: 'One or more selected publishing channels are not connected.' };
    }
    const accounts = await CampaignChannel.find({
      campaignId,
      status: 'verified',
      socialAccountId: { $in: accountIds },
    }).select('socialAccountId');
    const verifiedAccountIds = new Set(accounts.map((channel) => String(channel.socialAccountId)));

    if (!accountIds.every((accountId) => verifiedAccountIds.has(String(accountId)))) {
      return { ok: false, message: 'One or more selected publishing channels are not connected.' };
    }
    return { ok: true };
  }

  if (channelIds.length > 0) {
    const channels = await CampaignChannel.find({
      _id: { $in: channelIds },
      campaignId,
    }).select('_id status socialAccountId assignedHandlerEmail assignedHandlerUserId').lean();
    if (channels.length !== getUniqueIds(channelIds).length) {
      return { ok: false, message: 'One or more selected channels are not assigned to this campaign.' };
    }
    const unusableManualChannel = channels.some((channel) => (
      channel.status !== 'verified'
      && !channel.socialAccountId
      && !channel.assignedHandlerEmail
      && !channel.assignedHandlerUserId
    ));
    if (unusableManualChannel) {
      return { ok: false, message: 'Assign a handler email before scheduling an unverified channel manually.' };
    }
  }

  if (accountIds.length === 0) {
    return { ok: true };
  }

  const selectedAccounts = await SocialAccount.find({ _id: { $in: accountIds } })
    .select('_id platform username name accountId')
    .lean();
  if (selectedAccounts.length !== accountIds.length) {
    return { ok: false, message: 'One or more selected publishing channels were not found.' };
  }

  const accountKeys = new Set(
    selectedAccounts.flatMap((account) => (
      getAccountMatchHandles(account).map((handle) => `${account.platform}:${handle}`)
    ))
  );
  const assignedChannels = await CampaignChannel.find({ campaignId })
    .select('platform normalizedHandle')
    .lean();
  const assignedKeys = new Set(
    assignedChannels.map((channel) => `${channel.platform}:${normalizeChannelHandle(channel.normalizedHandle)}`)
  );

  const allAccountsAssigned = selectedAccounts.every((account) => (
    getAccountMatchHandles(account).some((handle) => assignedKeys.has(`${account.platform}:${handle}`))
  ));
  if (!allAccountsAssigned || accountKeys.size === 0) {
    return { ok: false, message: 'One or more selected channels are not assigned to this campaign.' };
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
      .populate('campaignChannelIds')
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
  const { socialAccountIds, campaignChannelIds, channelTargets, mediaIds, caption, scheduledAt, platformSpecifics } = req.body;
  const scheduleMode = normalizeScheduleMode(req.body.scheduleMode);

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
      const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });
      const newPosts = targets.map((target) => ({
        _id: `sp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
        campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
        mediaIds,
        caption: postCaption,
        scheduledAt: scheduledDate,
        scheduleMode,
        status: getInitialStatusForMode(scheduleMode),
        platformSpecifics: withPostCaption(platformSpecifics, postCaption, platformSpecifics?.type || 'reels'),
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      mockStore.scheduledPosts.push(...newPosts);
      return targets.length === 1
        ? res.status(201).json(newPosts[0])
        : res.status(201).json({
          message: `Successfully scheduled ${newPosts.length} posts.`,
          postsCount: newPosts.length,
          posts: newPosts,
        });
    }

    const access = await validateSchedulingAccess({
      campaignId,
      socialAccountIds,
      campaignChannelIds,
      channelTargets,
      mediaIds,
      allowDisconnectedAccounts: scheduleMode === 'manual',
    });
    if (!access.ok) {
      return res.status(400).json({ message: access.message });
    }

    if (!postCaption && mediaIds?.[0]) {
      const mediaItem = await Media.findOne({ _id: mediaIds[0], campaignId }).select('caption');
      postCaption = mediaItem?.caption || '';
    }

    const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });
    const posts = [];

    for (const target of targets) {
      const post = await ScheduledPost.create({
        userId: req.user._id,
        campaignId,
        socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
        campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
        mediaIds,
        caption: postCaption,
        scheduledAt: scheduledDate,
        scheduleMode,
        status: getInitialStatusForMode(scheduleMode),
        platformSpecifics: withPostCaption(platformSpecifics, postCaption, platformSpecifics?.type || 'reels'),
      });
      if (shouldQueuePost(post)) {
        await addPostToQueue(post);
      }
      posts.push(post);
    }

    res.status(201).json(posts.length === 1
      ? posts[0]
      : {
        message: `Successfully scheduled ${posts.length} posts.`,
        postsCount: posts.length,
        posts,
      });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Bulk Schedule posts sequentially
// @route   POST /api/scheduler/bulk
// @access  Private (Owner, Admin, Editor)
router.post('/bulk', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { socialAccountIds, campaignChannelIds, channelTargets, mediaIds, caption, startDate, intervalHours, type, platformSpecifics } = req.body;
  const scheduleMode = normalizeScheduleMode(req.body.scheduleMode);
  const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });

  if (targets.length === 0 || !mediaIds || mediaIds.length === 0) {
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
        campaignChannelIds,
        channelTargets,
        mediaIds,
        allowDisconnectedAccounts: scheduleMode === 'manual',
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
    for (const target of targets) {
      let currentScheduleTime = new Date(baseDate.getTime());
      
      for (const mediaId of mediaIds) {
        const scheduledTime = new Date(currentScheduleTime.getTime());
        const mediaCaption = mediaCaptionMap.get(String(mediaId)) || '';
        const postCaption = mediaCaption || caption || '';
        const postPlatformSpecifics = withPostCaption(platformSpecifics, postCaption, type);
        
        if (!isConnected) {
          const newPost = {
            _id: `sp_bulk_${Date.now()}_${index++}`,
            socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
            campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
            mediaIds: [mediaId],
            caption: postCaption,
            scheduledAt: scheduledTime,
            scheduleMode,
            status: getInitialStatusForMode(scheduleMode),
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
            socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
            campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
            mediaIds: [mediaId],
            caption: postCaption,
            scheduledAt: scheduledTime,
            scheduleMode,
            status: getInitialStatusForMode(scheduleMode),
            platformSpecifics: postPlatformSpecifics,
          });
          if (shouldQueuePost(post)) {
            await addPostToQueue(post);
          }
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

// @desc    Bulk schedule carousel sets sequentially
// @route   POST /api/scheduler/carousels
// @access  Private (Owner, Admin, Editor)
router.post('/carousels', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { socialAccountIds, campaignChannelIds, channelTargets, carouselSetIds, caption, startDate, intervalHours, platformSpecifics } = req.body;
  const scheduleMode = normalizeScheduleMode(req.body.scheduleMode);
  const targets = normalizeChannelTargets({ channelTargets, socialAccountIds, campaignChannelIds });

  if (targets.length === 0 || !carouselSetIds || carouselSetIds.length === 0) {
    return res.status(400).json({ message: 'Must select publishing channels and at least one carousel set' });
  }

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const baseDate = new Date(startDate || Date.now());
    const intervalMs = (parseFloat(intervalHours) || 2) * 60 * 60 * 1000;
    const accountIds = getUniqueIds(socialAccountIds);
    const channelIds = getUniqueIds(campaignChannelIds);
    const setIds = getUniqueIds(carouselSetIds);
    const createdPosts = [];

    if (!isConnected) {
      let index = 0;
      for (const target of targets) {
        let currentScheduleTime = new Date(baseDate.getTime());
        for (const setId of setIds) {
          const folder = mockStore.folders.find(f => String(f._id) === String(setId));
          const folderMedia = mockStore.media.filter(m => String(m.folderId) === String(setId));
          const orderedIds = (folder?.carouselOrder || []).filter(mediaId => folderMedia.some(m => String(m._id) === String(mediaId)));
          const unorderedIds = folderMedia.map(m => m._id).filter(mediaId => !orderedIds.includes(mediaId));
          const mediaIds = [...orderedIds, ...unorderedIds];
          if (mediaIds.length === 0) continue;

          const postCaption = folder?.carouselCaption || caption || '';
          const post = {
            _id: `sp_carousel_${Date.now()}_${index++}`,
            socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
            campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
            mediaIds,
            caption: postCaption,
            scheduledAt: new Date(currentScheduleTime.getTime()),
            scheduleMode,
            status: getInitialStatusForMode(scheduleMode),
            platformSpecifics: {
              ...(platformSpecifics || {}),
              type: 'carousel',
              carouselSetId: setId,
              carouselSetName: folder?.name || 'Carousel Set',
              carouselOrder: mediaIds,
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockStore.scheduledPosts.push(post);
          createdPosts.push(post);
          currentScheduleTime = new Date(currentScheduleTime.getTime() + intervalMs);
        }
      }

      return res.status(201).json({
        message: `Successfully scheduled ${createdPosts.length} carousel posts.`,
        postsCount: createdPosts.length,
        posts: createdPosts,
      });
    }

    if (scheduleMode === 'manual') {
      if (channelIds.length > 0) {
        const channels = await CampaignChannel.find({
          _id: { $in: channelIds },
          campaignId,
        }).select('_id status socialAccountId assignedHandlerEmail assignedHandlerUserId').lean();
        if (channels.length !== channelIds.length) {
          return res.status(400).json({ message: 'One or more selected channels are not assigned to this campaign.' });
        }
        const unusableManualChannel = channels.some((channel) => (
          channel.status !== 'verified'
          && !channel.socialAccountId
          && !channel.assignedHandlerEmail
          && !channel.assignedHandlerUserId
        ));
        if (unusableManualChannel) {
          return res.status(400).json({ message: 'Assign a handler email before scheduling an unverified channel manually.' });
        }
      }
      const selectedAccounts = await SocialAccount.find({ _id: { $in: accountIds } })
        .select('_id platform username name accountId')
        .lean();
      const assignedChannels = await CampaignChannel.find({ campaignId })
        .select('platform normalizedHandle')
        .lean();
      const assignedKeys = new Set(
        assignedChannels.map((channel) => `${channel.platform}:${normalizeChannelHandle(channel.normalizedHandle)}`)
      );
      const allAccountsAssigned = accountIds.length === 0 || (selectedAccounts.length === accountIds.length && selectedAccounts.every((account) => (
        getAccountMatchHandles(account).some((handle) => assignedKeys.has(`${account.platform}:${handle}`))
      )));
      if (!allAccountsAssigned) {
        return res.status(400).json({ message: 'One or more selected channels are not assigned to this campaign.' });
      }
    } else {
      if (accountIds.length === 0) {
        return res.status(400).json({ message: 'One or more selected publishing channels are not connected.' });
      }
      const channelAccess = await CampaignChannel.find({
        campaignId,
        status: 'verified',
        socialAccountId: { $in: accountIds },
      }).select('socialAccountId');
      const verifiedAccountIds = new Set(channelAccess.map((channel) => String(channel.socialAccountId)));
      if (!accountIds.every((accountId) => verifiedAccountIds.has(String(accountId)))) {
        return res.status(400).json({ message: 'One or more selected publishing channels are not connected.' });
      }
    }

    const folders = await Folder.find({
      _id: { $in: setIds },
      campaignId,
      kind: 'carousel_set',
    }).lean();
    if (folders.length !== setIds.length) {
      return res.status(400).json({ message: 'One or more carousel sets were not found.' });
    }

    const mediaItems = await Media.find({
      campaignId,
      folderId: { $in: setIds },
      type: { $in: ['image', 'video'] },
    }).select('_id folderId createdAt');
    const mediaByFolder = new Map();
    mediaItems.forEach((item) => {
      const folderId = String(item.folderId);
      if (!mediaByFolder.has(folderId)) mediaByFolder.set(folderId, []);
      mediaByFolder.get(folderId).push(item);
    });

    for (const target of targets) {
      let currentScheduleTime = new Date(baseDate.getTime());

      for (const setId of setIds) {
        const folder = folders.find(f => String(f._id) === String(setId));
        const folderMedia = mediaByFolder.get(String(setId)) || [];
        const mediaIdSet = new Set(folderMedia.map(item => String(item._id)));
        const orderedIds = (folder.carouselOrder || [])
          .map(id => String(id))
          .filter(mediaId => mediaIdSet.has(mediaId));
        const unorderedIds = folderMedia
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
          .map(item => String(item._id))
          .filter(mediaId => !orderedIds.includes(mediaId));
        const mediaIds = [...orderedIds, ...unorderedIds];

        if (mediaIds.length === 0) {
          return res.status(400).json({ message: `${folder.name} has no supported carousel slides.` });
        }

        const postCaption = folder.carouselCaption || caption || '';
        const postPlatformSpecifics = withPostCaption({
          ...(platformSpecifics || {}),
          type: 'carousel',
          carouselSetId: folder._id,
          carouselSetName: folder.name,
          carouselOrder: mediaIds,
        }, postCaption, 'carousel');

        const post = await ScheduledPost.create({
          userId: req.user._id,
          campaignId,
          socialAccountIds: target.socialAccountId ? [target.socialAccountId] : [],
          campaignChannelIds: target.campaignChannelId ? [target.campaignChannelId] : [],
          mediaIds,
          caption: postCaption,
          scheduledAt: new Date(currentScheduleTime.getTime()),
          scheduleMode,
          status: getInitialStatusForMode(scheduleMode),
          platformSpecifics: postPlatformSpecifics,
        });
        if (shouldQueuePost(post)) {
          await addPostToQueue(post);
        }
        createdPosts.push(post);
        currentScheduleTime = new Date(currentScheduleTime.getTime() + intervalMs);
      }
    }

    res.status(201).json({
      message: `Successfully scheduled ${createdPosts.length} carousel posts.`,
      postsCount: createdPosts.length,
      posts: createdPosts,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Mark creator access/download on a manual or hybrid post
// @route   POST /api/scheduler/:id/downloaded
// @access  Private
router.post('/:id/downloaded', protect, async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const post = mockStore.scheduledPosts.find(p => p._id === id);
      if (!post) return res.status(404).json({ message: 'Post not found' });
      post.manualDownloadedAt = new Date();
      if (post.status === 'manual_ready') post.status = 'downloaded';
      post.updatedAt = new Date();
      return res.status(200).json(post);
    }

    const post = await ScheduledPost.findById(id)
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds');
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (!['manual', 'hybrid'].includes(post.scheduleMode || 'auto')) {
      return res.status(400).json({ message: 'Only manual or hybrid posts can be downloaded by creators.' });
    }
    if (!(await canAccessManualPost(post, req.user))) {
      return res.status(403).json({ message: 'Access denied for this scheduled post.' });
    }
    if (terminalManualStatuses.has(post.status)) {
      return res.status(400).json({ message: 'This post is already complete or cancelled.' });
    }

    post.manualDownloadedAt = new Date();
    if (post.status === 'manual_ready') post.status = 'downloaded';
    await post.save();

    res.status(200).json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Mark a manual/hybrid post as posted by the creator
// @route   POST /api/scheduler/:id/manual-posted
// @access  Private
router.post('/:id/manual-posted', protect, async (req, res) => {
  const { id } = req.params;
  const { manualPostUrl = '' } = req.body || {};

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const post = mockStore.scheduledPosts.find(p => p._id === id);
      if (!post) return res.status(404).json({ message: 'Post not found' });
      post.status = 'posted_manual';
      post.publishSource = 'creator';
      post.manualPostedAt = new Date();
      post.manualPostUrl = manualPostUrl;
      post.postedByUserId = req.user._id;
      post.updatedAt = new Date();
      return res.status(200).json(post);
    }

    const post = await ScheduledPost.findById(id)
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds');
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (!['manual', 'hybrid'].includes(post.scheduleMode || 'auto')) {
      return res.status(400).json({ message: 'Only manual or hybrid posts can be marked as manually posted.' });
    }
    if (!(await canAccessManualPost(post, req.user))) {
      return res.status(403).json({ message: 'Access denied for this scheduled post.' });
    }
    if (terminalManualStatuses.has(post.status)) {
      return res.status(400).json({ message: 'This post is already complete or cancelled.' });
    }

    await removePostFromQueue(post._id);
    post.status = 'posted_manual';
    post.publishSource = 'creator';
    post.manualPostedAt = new Date();
    post.manualPostUrl = manualPostUrl;
    post.postedByUserId = req.user._id;
    await post.save();

    res.status(200).json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Return a hybrid post back to automatic publishing
// @route   POST /api/scheduler/:id/return-to-auto
// @access  Private (Owner, Admin, Editor)
router.post('/:id/return-to-auto', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const post = mockStore.scheduledPosts.find(p => p._id === id);
      if (!post) return res.status(404).json({ message: 'Post not found' });
      post.scheduleMode = 'hybrid';
      post.status = 'scheduled';
      post.publishSource = null;
      post.manualPostedAt = null;
      post.manualPostUrl = '';
      post.postedByUserId = null;
      post.updatedAt = new Date();
      return res.status(200).json(post);
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const post = await ScheduledPost.findOne({ _id: id, campaignId });
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (post.scheduleMode !== 'hybrid') {
      return res.status(400).json({ message: 'Only hybrid posts can be returned to automatic publishing.' });
    }

    post.status = 'scheduled';
    post.publishSource = null;
    post.manualPostedAt = null;
    post.manualPostUrl = '';
    post.postedByUserId = null;
    await post.save();
    await removePostFromQueue(post._id);
    await addPostToQueue(post);

    const populated = await ScheduledPost.findOne({ _id: id, campaignId })
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds');
    res.status(200).json(populated);
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
  const nextScheduleMode = req.body.scheduleMode === undefined ? null : normalizeScheduleMode(req.body.scheduleMode);

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
      if (nextScheduleMode) post.scheduleMode = nextScheduleMode;
      if (status) post.status = status;
      if (nextScheduleMode && !status) post.status = getInitialStatusForMode(nextScheduleMode);
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
    if (nextScheduleMode) post.scheduleMode = nextScheduleMode;
    if (status) post.status = status;
    if (nextScheduleMode && !status) post.status = getInitialStatusForMode(nextScheduleMode);
    
    await post.save();

    await removePostFromQueue(post._id);
    if (shouldQueuePost(post)) {
      await addPostToQueue(post);
    }
    
    const populated = await ScheduledPost.findOne({ _id: id, campaignId })
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds');
      
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete/cancel active schedule queue for one account
// @route   DELETE /api/scheduler/queue/account/:accountId
// @access  Private (Owner, Admin, Editor)
router.delete('/queue/account/:accountId', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { accountId } = req.params;

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;

    if (!isConnected) {
      const beforeCount = mockStore.scheduledPosts.length;
      const shouldDelete = (post) => (
        activeQueueStatuses.includes(post.status)
        && idsToStrings(post.socialAccountIds).includes(String(accountId))
      );
      mockStore.scheduledPosts = mockStore.scheduledPosts.filter((post) => !shouldDelete(post));
      return res.status(200).json({
        message: 'Account schedule queue removed successfully',
        deletedCount: beforeCount - mockStore.scheduledPosts.length,
      });
    }

    const query = {
      campaignId,
      status: { $in: activeQueueStatuses },
      socialAccountIds: accountId,
    };

    const posts = await ScheduledPost.find(query).select('_id socialAccountIds');
    let deletedCount = 0;

    for (const post of posts) {
      const accountIds = idsToStrings(post.socialAccountIds);
      if (accountIds.length > 1) {
        post.socialAccountIds = post.socialAccountIds.filter((id) => String(id) !== String(accountId));
        await post.save();
      } else {
        await removePostFromQueue(post._id);
        await ScheduledPost.deleteOne({ _id: post._id, campaignId });
        deletedCount += 1;
      }
    }

    res.status(200).json({
      message: 'Account schedule queue removed successfully',
      deletedCount,
    });
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

// @desc    Get all scheduled posts assigned to this creator's accounts
router.get('/creator/posts', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(200).json([]);
    }

    // 1. Find social accounts and manual channel assignments controlled by this handler
    const creatorAccounts = await SocialAccount.find({ userId: req.user._id }).select('_id').lean();
    const creatorAccountIds = creatorAccounts.map(acc => acc._id);
    const creatorAccountIdSet = new Set(creatorAccountIds.map((id) => String(id)));
    const handlerEmail = (req.user.email || '').trim().toLowerCase();
    const assignedChannels = await CampaignChannel.find({
      $or: [
        { assignedHandlerUserId: req.user._id },
        ...(handlerEmail ? [{ assignedHandlerEmail: handlerEmail }] : []),
      ],
    }).select('_id').lean();
    const assignedChannelIds = assignedChannels.map((channel) => channel._id);
    const assignedChannelIdSet = new Set(assignedChannelIds.map((id) => String(id)));

    if (creatorAccountIds.length === 0 && assignedChannelIds.length === 0) {
      return res.status(200).json([]);
    }

    // 2. Find scheduled posts containing these accounts/channels, but only expose this handler's targets
    const posts = await ScheduledPost.find({
      $or: [
        { socialAccountIds: { $in: creatorAccountIds } },
        { campaignChannelIds: { $in: assignedChannelIds } },
      ],
    })
      .populate('socialAccountIds')
      .populate('campaignChannelIds')
      .populate('mediaIds')
      .sort({ scheduledAt: 1 })
      .lean();

    res.status(200).json(posts.map((post) => ({
      ...post,
      socialAccountIds: (post.socialAccountIds || []).filter((account) => (
        creatorAccountIdSet.has(String(account?._id || account))
      )),
      campaignChannelIds: (post.campaignChannelIds || []).filter((channel) => (
        assignedChannelIdSet.has(String(channel?._id || channel))
      )),
    })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
