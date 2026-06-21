import express from 'express';
import multer from 'multer';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import SocialAccount from '../models/SocialAccount.js';
import { uploadFile, deleteFile } from '../services/r2Service.js';
import { createAndUploadThumbnail, fetchMediaBuffer } from '../services/thumbnailService.js';
import { protect, authorize } from '../middleware/auth.js';
import { getOriginalStorageKey, getThumbnailStorageKey } from '../utils/storageKeys.js';

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

const getCampaignQuery = (req, extra = {}) => {
  const campaignId = getActiveCampaignId(req);
  if (campaignId) {
    return { campaignId, ...extra };
  }

  return { userId: getScopedUserId(req), ...extra };
};

const parseIdList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const getValidSocialAccountIds = async (accountIds, campaignId) => {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return [];

  const accounts = await SocialAccount.find({
    _id: { $in: uniqueIds },
    campaignId,
    isConnected: true,
  }).select('_id');

  return accounts.map((account) => account._id);
};

const thumbnailEligibleTypes = ['image', 'video'];

const buildThumbnailFromUpload = async ({ file, mediaType, storageKey, thumbnailStorageKey }) => {
  if (!thumbnailEligibleTypes.includes(mediaType)) return {};
  const thumbnail = await createAndUploadThumbnail({
    buffer: file.buffer,
    mediaType,
    originalName: file.originalname,
    baseStorageKey: storageKey,
    thumbnailStorageKey,
  });
  return thumbnail || {};
};

const buildThumbnailFromMedia = async (mediaItem) => {
  if (!mediaItem?.url || !thumbnailEligibleTypes.includes(mediaItem.type)) return null;
  const buffer = await fetchMediaBuffer(mediaItem.url);
  return createAndUploadThumbnail({
    buffer,
    mediaType: mediaItem.type,
    originalName: mediaItem.name,
    baseStorageKey: mediaItem.storageKey || mediaItem._id,
    thumbnailStorageKey: getThumbnailStorageKey({
      userId: mediaItem.userId,
      folderId: mediaItem.folderId,
      mediaId: mediaItem._id,
    }),
  });
};

// Multer in-memory storage configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max limit
  }
});

// @desc    Proxy media files from R2 to add CORS and CORP headers
// @route   GET /api/media/proxy
// @access  Public
router.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ message: 'URL parameter is required' });
  }

  try {
    // Only allow proxying from trusted domains like R2
    if (!url.startsWith('https://pub-') && !url.includes('r2.cloudflarestorage.com')) {
      return res.status(403).json({ message: 'Access denied: untrusted media origin' });
    }

    const headers = {};
    if (req.headers.range) {
      headers.range = req.headers.range;
    }

    const response = await fetch(url, { headers });
    
    // Set headers
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const acceptRanges = response.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

    const contentRange = response.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    if (response.status === 206) {
      res.status(206);
    } else if (!response.ok) {
      return res.status(response.status).json({ message: 'Failed to fetch remote media' });
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    console.error('Proxy error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ message: error.message });
    }
  }
});

// ================= Folder Routes =================

// @desc    Get all folders
// @route   GET /api/media/folders
// @access  Private
router.get('/folders', protect, async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      return res.status(200).json(mockStore.folders);
    }
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const folders = await Folder.find(getCampaignQuery(req));
    res.status(200).json(folders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create a new folder
// @route   POST /api/media/folders
// @access  Private (Owner, Admin, Editor)
router.post('/folders', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { name, parentFolderId } = req.body;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const newFolder = {
        _id: `f_${Date.now()}`,
        name,
        parentFolderId: parentFolderId || null,
        createdAt: new Date(),
      };
      mockStore.folders.push(newFolder);
      return res.status(201).json(newFolder);
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const folder = await Folder.create({ userId: req.user._id, campaignId, name, parentFolderId: parentFolderId || null });
    res.status(201).json(folder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete folder
// @route   DELETE /api/media/folders/:id
// @access  Private (Owner, Admin)
router.delete('/folders/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const index = mockStore.folders.findIndex(f => f._id === id);
      if (index === -1) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      mockStore.folders.splice(index, 1);
      // Re-assign media in this folder to root
      mockStore.media.forEach(m => {
        if (m.folderId === id) m.folderId = null;
      });
      return res.status(200).json({ message: 'Folder deleted successfully' });
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const folder = await Folder.findOne({ _id: id, campaignId });
    if (!folder) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    await Folder.deleteOne({ _id: id, campaignId });
    // Update media referencing this folder to null
    await Media.updateMany({ campaignId, folderId: id }, { folderId: null });
    res.status(200).json({ message: 'Folder deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Media Routes =================

// @desc    Get all media assets
// @route   GET /api/media
// @access  Private
router.get('/', protect, async (req, res) => {
  const { folderId, tag, accountId } = req.query;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      let filtered = [...mockStore.media];
      
      if (folderId) {
        filtered = filtered.filter(m => m.folderId === folderId || (folderId === 'root' && !m.folderId));
      }
      if (tag) {
        filtered = filtered.filter(m => m.tags.includes(tag.toLowerCase()));
      }
      if (accountId) {
        filtered = filtered.filter((m) => {
          const mediaAccountIds = m.socialAccountIds || [];
          return mediaAccountIds.length === 0 || mediaAccountIds.includes(accountId);
        });
      }
      
      // Sort newest first
      filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.status(200).json(filtered);
    }
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const query = getCampaignQuery(req);
    if (folderId) {
      query.folderId = folderId === 'root' ? null : folderId;
    }
    if (tag) {
      query.tags = tag.toLowerCase();
    }
    if (accountId) {
      query.$or = [
        { socialAccountIds: accountId },
        { socialAccountIds: { $size: 0 } },
      ];
    }

    const media = await Media.find(query)
      .populate('socialAccountIds', 'name username platform avatarUrl isConnected')
      .sort({ createdAt: -1 });
    res.status(200).json(media);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Upload media file
// @route   POST /api/media/upload
// @access  Private (Owner, Admin, Editor)
router.post('/upload', protect, authorize('owner', 'admin', 'editor'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const { folderId, tags, caption } = req.body;
  const campaignId = requireCampaignId(req, res);
  if (!campaignId) return;
  const requestedAccountIds = parseIdList(req.body.socialAccountIds);
  const mimeType = req.file.mimetype;
  let mediaType = 'image';

  if (mimeType.startsWith('video/')) {
    mediaType = 'video';
  } else if (mimeType.startsWith('image/')) {
    mediaType = 'image';
  } else if (mimeType.startsWith('audio/') || mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') {
    mediaType = 'audio';
  }

  try {
    const tagList = tags ? tags.split(',').map(t => t.trim().toLowerCase()) : [];
    const isConnected = getDBStatus();
    let socialAccountIds = requestedAccountIds;

    if (isConnected) {
      socialAccountIds = await getValidSocialAccountIds(requestedAccountIds, campaignId);
      if (requestedAccountIds.length > 0 && socialAccountIds.length !== requestedAccountIds.length) {
        return res.status(400).json({ message: 'One or more selected publishing channels are not connected.' });
      }
    }

    if (!isConnected) {
      const mediaId = `m_${Date.now()}`;
      const resolvedFolderId = folderId && folderId !== 'null' ? folderId : null;
      const storageKey = getOriginalStorageKey({
        userId: req.user?._id || 'mock-user',
        campaignId,
        folderId: resolvedFolderId,
        mediaId,
        originalName: req.file.originalname,
      });
      const { url } = await uploadFile({ ...req.file, storageKey });
      const thumbnailFields = await buildThumbnailFromUpload({
        file: req.file,
        mediaType,
        storageKey,
        thumbnailStorageKey: getThumbnailStorageKey({
          userId: req.user?._id || 'mock-user',
          folderId: resolvedFolderId,
          mediaId,
        }),
      });
      const newMedia = {
        _id: mediaId,
        folderId: resolvedFolderId,
        name: req.file.originalname,
        type: mediaType,
        url,
        storageKey,
        ...thumbnailFields,
        caption: caption || '',
        socialAccountIds,
        tags: tagList,
        size: req.file.size,
        createdAt: new Date(),
      };
      mockStore.media.push(newMedia);
      return res.status(201).json(newMedia);
    }

    const mediaId = new Media()._id;
    const resolvedFolderId = folderId && folderId !== 'null' ? folderId : null;
    const storageKey = getOriginalStorageKey({
      userId: req.user._id,
      campaignId,
      folderId: resolvedFolderId,
      mediaId,
      originalName: req.file.originalname,
    });
    const { url } = await uploadFile({ ...req.file, storageKey });
    const thumbnailFields = await buildThumbnailFromUpload({
      file: req.file,
      mediaType,
      storageKey,
      thumbnailStorageKey: getThumbnailStorageKey({
        userId: req.user._id,
        folderId: resolvedFolderId,
        mediaId,
      }),
    });

    const media = await Media.create({
      _id: mediaId,
      userId: req.user._id,
      campaignId,
      folderId: resolvedFolderId,
      socialAccountIds,
      name: req.file.originalname,
      type: mediaType,
      url,
      storageKey,
      ...thumbnailFields,
      caption: caption || '',
      tags: tagList,
      size: req.file.size,
    });

    const populated = await Media.findById(media._id)
      .populate('socialAccountIds', 'name username platform avatarUrl isConnected');

    res.status(201).json(populated);
  } catch (error) {
    console.error('Upload error in route:', error);
    res.status(500).json({ message: error.message });
  }
});

// @desc    Update media metadata
// @route   PUT /api/media/:id
// @access  Private (Owner, Admin, Editor)
router.put('/:id', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;
  const { caption, tags } = req.body;

  try {
    const isConnected = getDBStatus();

    if (!isConnected) {
      const mediaItem = mockStore.media.find(m => m._id === id);
      if (!mediaItem) {
        return res.status(404).json({ message: 'Media not found' });
      }
      if (caption !== undefined) mediaItem.caption = caption;
      if (tags !== undefined) {
        mediaItem.tags = Array.isArray(tags)
          ? tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean)
          : String(tags).split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
      }
      mediaItem.updatedAt = new Date();
      return res.status(200).json(mediaItem);
    }

    const updates = {};
    if (caption !== undefined) updates.caption = caption;
    if (tags !== undefined) {
      updates.tags = Array.isArray(tags)
        ? tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean)
        : String(tags).split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const media = await Media.findOneAndUpdate(
      { _id: id, campaignId },
      updates,
      { new: true }
    ).populate('socialAccountIds', 'name username platform avatarUrl isConnected');

    if (!media) {
      return res.status(404).json({ message: 'Media not found' });
    }

    res.status(200).json(media);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete media asset
// @route   DELETE /api/media/:id
// @access  Private (Owner, Admin)
router.delete('/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const index = mockStore.media.findIndex(m => m._id === id);
      if (index === -1) {
        return res.status(404).json({ message: 'Media not found' });
      }

      const mediaItem = mockStore.media[index];
      await deleteFile(mediaItem.storageKey);
      if (mediaItem.thumbnailStorageKey) {
        await deleteFile(mediaItem.thumbnailStorageKey);
      }
      mockStore.media.splice(index, 1);
      return res.status(200).json({ message: 'Media asset deleted successfully' });
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const media = await Media.findOne({ _id: id, campaignId });
    if (!media) {
      return res.status(404).json({ message: 'Media not found' });
    }

    await deleteFile(media.storageKey);
    if (media.thumbnailStorageKey) {
      await deleteFile(media.thumbnailStorageKey);
    }
    await Media.deleteOne({ _id: id, campaignId });
    res.status(200).json({ message: 'Media asset deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Generate missing low-quality thumbnails for existing media
// @route   POST /api/media/thumbnails/backfill
// @access  Private (Owner, Admin, Editor)
router.post('/thumbnails/backfill', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { folderId, overwrite = false } = req.body;

  try {
    const isConnected = getDBStatus();
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const query = {
      campaignId,
      type: { $in: thumbnailEligibleTypes },
    };

    if (folderId) {
      query.folderId = folderId === 'root' ? null : folderId;
    }

    if (!overwrite) {
      query.$or = [
        { thumbnailUrl: { $exists: false } },
        { thumbnailUrl: '' },
        { thumbnailUrl: null },
      ];
    }

    if (!isConnected) {
      const candidates = mockStore.media.filter((item) => {
        if (!thumbnailEligibleTypes.includes(item.type)) return false;
        if (!overwrite && item.thumbnailUrl) return false;
        if (!folderId) return true;
        if (folderId === 'root') return !item.folderId;
        return item.folderId === folderId;
      });

      const results = [];
      for (const item of candidates) {
        try {
          const thumbnail = await buildThumbnailFromMedia(item);
          if (thumbnail) {
            Object.assign(item, thumbnail);
            results.push({ id: item._id, status: 'generated' });
          } else {
            results.push({ id: item._id, status: 'skipped' });
          }
        } catch (error) {
          results.push({ id: item._id, status: 'failed', message: error.message });
        }
      }

      return res.status(200).json({
        matched: candidates.length,
        generated: results.filter(item => item.status === 'generated').length,
        failed: results.filter(item => item.status === 'failed').length,
        results,
      });
    }

    const mediaItems = await Media.find(query);
    const results = [];

    for (const item of mediaItems) {
      try {
        if (overwrite && item.thumbnailStorageKey) {
          await deleteFile(item.thumbnailStorageKey);
        }

        const thumbnail = await buildThumbnailFromMedia(item);
        if (thumbnail) {
          item.thumbnailUrl = thumbnail.thumbnailUrl;
          item.thumbnailStorageKey = thumbnail.thumbnailStorageKey;
          item.thumbnailGeneratedAt = thumbnail.thumbnailGeneratedAt;
          await item.save();
          results.push({ id: item._id, status: 'generated' });
        } else {
          results.push({ id: item._id, status: 'skipped' });
        }
      } catch (error) {
        results.push({ id: item._id, status: 'failed', message: error.message });
      }
    }

    res.status(200).json({
      matched: mediaItems.length,
      generated: results.filter(item => item.status === 'generated').length,
      failed: results.filter(item => item.status === 'failed').length,
      results,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
