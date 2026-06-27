import express from 'express';
import multer from 'multer';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import CampaignChannel from '../models/CampaignChannel.js';
import SocialAccount from '../models/SocialAccount.js';
import { uploadFile, deleteFile, createPresignedUploadUrl, fileExists, getStorageUrl, isR2DirectUploadAvailable } from '../services/r2Service.js';
import { createAndUploadThumbnail, fetchMediaBuffer } from '../services/thumbnailService.js';
import { protect, authorize } from '../middleware/auth.js';
import { getOriginalStorageKey, getThumbnailStorageKey } from '../utils/storageKeys.js';

const router = express.Router();
const ADMIN_ROLES = ['owner', 'admin'];
const MEDIA_PUBLIC_HOST = 'media.theeasypost.com';

const isTrustedMediaUrl = (url) => {
  try {
    return new URL(url).hostname === MEDIA_PUBLIC_HOST;
  } catch {
    return false;
  }
};

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

const parseTagList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(tag => String(tag).trim().toLowerCase()).filter(Boolean);
  }
  return String(value).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
};

const getMediaTypeFromMime = (mimeType = '') => {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/') || mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') return 'audio';
  return 'image';
};

const getValidSocialAccountIds = async (accountIds, campaignId) => {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return [];

  const channels = await CampaignChannel.find({
    campaignId,
    status: 'verified',
    socialAccountId: { $in: uniqueIds },
  }).select('socialAccountId');

  return channels.map((channel) => channel.socialAccountId);
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
    // Only allow proxying from the configured public media domain.
    if (!isTrustedMediaUrl(url)) {
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

// @desc    Rename folder
// @route   PUT /api/media/folders/:id
// @access  Private (Owner, Admin, Editor)
router.put('/folders/:id', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;
  const nextName = String(req.body?.name || '').trim();

  if (!nextName) {
    return res.status(400).json({ message: 'Folder name is required.' });
  }

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const folder = mockStore.folders.find(f => f._id === id);
      if (!folder) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      folder.name = nextName;
      folder.updatedAt = new Date();
      return res.status(200).json(folder);
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const folder = await Folder.findOneAndUpdate(
      { _id: id, campaignId },
      { name: nextName },
      { new: true }
    );

    if (!folder) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    res.status(200).json(folder);
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
  const { folderId, tag, accountId, page, limit } = req.query;

  try {
    const isConnected = getDBStatus();
    
    let queryLimit = undefined;
    let querySkip = undefined;
    if (page && limit) {
      queryLimit = parseInt(limit, 10);
      querySkip = (parseInt(page, 10) - 1) * queryLimit;
    }

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
      
      if (querySkip !== undefined && queryLimit !== undefined) {
        filtered = filtered.slice(querySkip, querySkip + queryLimit);
      }
      
      return res.status(200).json(filtered);
    }
    const PLATFORM_AUDIO_FOLDER_ID = '6a35f428fa3873d31da585b8';
    const folderIdStr = folderId ? String(folderId) : '';
    const query = {};

    if (folderIdStr === PLATFORM_AUDIO_FOLDER_ID) {
      query.folderId = PLATFORM_AUDIO_FOLDER_ID;
    } else {
      const campaignId = requireCampaignId(req, res);
      if (!campaignId) return;
      Object.assign(query, getCampaignQuery(req));
      if (folderId) {
        query.folderId = folderId === 'root' ? null : folderId;
      }
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

    let dbQuery = Media.find(query)
      .populate('socialAccountIds', 'name username platform avatarUrl isConnected')
      .sort({ createdAt: -1 });

    if (querySkip !== undefined && queryLimit !== undefined) {
      dbQuery = dbQuery.skip(querySkip).limit(queryLimit);
    }

    const media = await dbQuery;
    res.status(200).json(media);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create a signed R2 upload URL for direct browser upload
// @route   POST /api/media/direct-upload/init
// @access  Private (Owner, Admin, Editor)
router.post('/direct-upload/init', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const campaignId = requireCampaignId(req, res);
  if (!campaignId) return;

  if (!getDBStatus()) {
    return res.status(409).json({ message: 'Direct upload requires a database connection.' });
  }
  if (!isR2DirectUploadAvailable()) {
    return res.status(409).json({ message: 'Direct upload requires Cloudflare R2 configuration.' });
  }

  const { name, contentType, folderId } = req.body || {};
  if (!name || !contentType) {
    return res.status(400).json({ message: 'File name and content type are required.' });
  }

  try {
    const mediaId = new Media()._id;
    const resolvedFolderId = folderId && folderId !== 'null' ? folderId : null;
    const storageKey = getOriginalStorageKey({
      userId: req.user._id,
      campaignId,
      folderId: resolvedFolderId,
      mediaId,
      originalName: name,
    });
    const upload = await createPresignedUploadUrl({
      storageKey,
      contentType,
    });

    res.status(200).json({
      mediaId,
      storageKey,
      url: upload.url,
      uploadUrl: upload.uploadUrl,
      expiresIn: upload.expiresIn,
    });
  } catch (error) {
    console.error('Direct upload init error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @desc    Complete a direct R2 upload and create the media metadata record
// @route   POST /api/media/direct-upload/complete
// @access  Private (Owner, Admin, Editor)
router.post('/direct-upload/complete', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const campaignId = requireCampaignId(req, res);
  if (!campaignId) return;

  if (!getDBStatus()) {
    return res.status(409).json({ message: 'Direct upload requires a database connection.' });
  }
  if (!isR2DirectUploadAvailable()) {
    return res.status(409).json({ message: 'Direct upload requires Cloudflare R2 configuration.' });
  }

  const {
    mediaId,
    name,
    contentType = '',
    folderId,
    storageKey,
    caption = '',
    tags,
    size,
  } = req.body || {};

  if (!mediaId || !name || !storageKey) {
    return res.status(400).json({ message: 'Media id, file name, and storage key are required.' });
  }

  try {
    const requestedAccountIds = parseIdList(req.body.socialAccountIds);
    const socialAccountIds = await getValidSocialAccountIds(requestedAccountIds, campaignId);
    if (requestedAccountIds.length > 0 && socialAccountIds.length !== requestedAccountIds.length) {
      return res.status(400).json({ message: 'One or more selected publishing channels are not connected.' });
    }

    const resolvedFolderId = folderId && folderId !== 'null' ? folderId : null;
    const expectedStorageKey = getOriginalStorageKey({
      userId: req.user._id,
      campaignId,
      folderId: resolvedFolderId,
      mediaId,
      originalName: name,
    });
    if (storageKey !== expectedStorageKey) {
      return res.status(400).json({ message: 'Upload storage key does not match this media asset.' });
    }

    const existing = await Media.findOne({ _id: mediaId, campaignId })
      .populate('socialAccountIds', 'name username platform avatarUrl isConnected');
    if (existing) {
      return res.status(200).json(existing);
    }

    const exists = await fileExists(storageKey);
    if (!exists) {
      return res.status(400).json({ message: 'Uploaded file was not found in R2.' });
    }

    const media = await Media.create({
      _id: mediaId,
      userId: req.user._id,
      campaignId,
      folderId: resolvedFolderId,
      socialAccountIds,
      name,
      type: getMediaTypeFromMime(contentType),
      url: getStorageUrl(storageKey),
      storageKey,
      caption: caption || '',
      tags: parseTagList(tags),
      size: Number(size) || undefined,
    });

    const populated = await Media.findById(media._id)
      .populate('socialAccountIds', 'name username platform avatarUrl isConnected');

    res.status(201).json(populated);
  } catch (error) {
    console.error('Direct upload complete error:', error);
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
  const mediaType = getMediaTypeFromMime(mimeType);

  try {
    const tagList = parseTagList(tags);
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

// @desc    Download a media asset for creator/manual posting flows
// @route   GET /api/media/:id/download
// @access  Private
router.get('/:id/download', protect, async (req, res) => {
  const { id } = req.params;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const mediaItem = mockStore.media.find(m => m._id === id);
      if (!mediaItem) return res.status(404).json({ message: 'Media not found' });
      return res.redirect(mediaItem.url);
    }

    const media = await Media.findById(id).lean();
    if (!media) return res.status(404).json({ message: 'Media not found' });

    const mediaAccountIds = (media.socialAccountIds || []).map(accountId => String(accountId));
    let allowed = ADMIN_ROLES.includes(req.user?.role) || String(media.userId) === String(req.user._id);

    if (!allowed && mediaAccountIds.length > 0) {
      const ownedAccount = await SocialAccount.exists({
        _id: { $in: mediaAccountIds },
        userId: req.user._id,
      });
      allowed = Boolean(ownedAccount);
    }

    if (!allowed) {
      return res.status(403).json({ message: 'Access denied for this media asset.' });
    }

    res.redirect(media.url);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Update media metadata
// @route   PUT /api/media/:id
// @access  Private (Owner, Admin, Editor)
router.put('/:id', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;
  const { caption, tags, name } = req.body;

  try {
    const isConnected = getDBStatus();

    if (!isConnected) {
      const mediaItem = mockStore.media.find(m => m._id === id);
      if (!mediaItem) {
        return res.status(404).json({ message: 'Media not found' });
      }
      if (caption !== undefined) mediaItem.caption = caption;
      if (name !== undefined) {
        const trimmedName = String(name).trim();
        if (!trimmedName) {
          return res.status(400).json({ message: 'File name cannot be empty.' });
        }
        mediaItem.name = trimmedName;
      }
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
    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({ message: 'File name cannot be empty.' });
      }
      updates.name = trimmedName;
    }
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
