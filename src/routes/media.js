import express from 'express';
import multer from 'multer';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import SocialAccount from '../models/SocialAccount.js';
import { uploadFile, deleteFile } from '../services/r2Service.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();
const ADMIN_ROLES = ['owner', 'admin'];

const getScopedUserId = (req) => {
  if (ADMIN_ROLES.includes(req.user?.role) && req.query.userId) {
    return req.query.userId;
  }
  return req.user._id;
};

const parseIdList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const getValidSocialAccountIds = async (accountIds, userId) => {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return [];

  const accounts = await SocialAccount.find({
    _id: { $in: uniqueIds },
    userId,
    isConnected: true,
  }).select('_id');

  return accounts.map((account) => account._id);
};

// Multer in-memory storage configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max limit
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
    const folders = await Folder.find({ userId: req.user._id });
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

    const folder = await Folder.create({ userId: req.user._id, name, parentFolderId: parentFolderId || null });
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

    const folder = await Folder.findOne({ _id: id, userId: req.user._id });
    if (!folder) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    await Folder.deleteOne({ _id: id, userId: req.user._id });
    // Update media referencing this folder to null
    await Media.updateMany({ userId: req.user._id, folderId: id }, { folderId: null });
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
        filtered = filtered.filter(m => (m.socialAccountIds || []).includes(accountId));
      }
      
      // Sort newest first
      filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.status(200).json(filtered);
    }
    const query = { userId: getScopedUserId(req) };
    if (folderId) {
      query.folderId = folderId === 'root' ? null : folderId;
    }
    if (tag) {
      query.tags = tag.toLowerCase();
    }
    if (accountId) {
      query.socialAccountIds = accountId;
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
  const requestedAccountIds = parseIdList(req.body.socialAccountIds);
  const mimeType = req.file.mimetype;
  let mediaType = 'image';

  if (mimeType.startsWith('video/')) {
    mediaType = 'video';
  } else if (mimeType.startsWith('image/')) {
    mediaType = 'image';
  }

  try {
    const tagList = tags ? tags.split(',').map(t => t.trim().toLowerCase()) : [];
    const isConnected = getDBStatus();
    let socialAccountIds = requestedAccountIds;

    if (isConnected) {
      socialAccountIds = await getValidSocialAccountIds(requestedAccountIds, req.user._id);
      if (requestedAccountIds.length === 0 || socialAccountIds.length !== requestedAccountIds.length) {
        return res.status(400).json({ message: 'Select at least one connected social account for this media asset.' });
      }
    }

    const { url, storageKey } = await uploadFile(req.file);

    if (!isConnected) {
      const newMedia = {
        _id: `m_${Date.now()}`,
        folderId: folderId && folderId !== 'null' ? folderId : null,
        name: req.file.originalname,
        type: mediaType,
        url,
        storageKey,
        caption: caption || '',
        socialAccountIds,
        tags: tagList,
        size: req.file.size,
        createdAt: new Date(),
      };
      mockStore.media.push(newMedia);
      return res.status(201).json(newMedia);
    }

    const media = await Media.create({
      userId: req.user._id,
      folderId: folderId && folderId !== 'null' ? folderId : null,
      socialAccountIds,
      name: req.file.originalname,
      type: mediaType,
      url,
      storageKey,
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

    const media = await Media.findOneAndUpdate(
      { _id: id, userId: req.user._id },
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
      mockStore.media.splice(index, 1);
      return res.status(200).json({ message: 'Media asset deleted successfully' });
    }

    const media = await Media.findOne({ _id: id, userId: req.user._id });
    if (!media) {
      return res.status(404).json({ message: 'Media not found' });
    }

    await deleteFile(media.storageKey);
    await Media.deleteOne({ _id: id, userId: req.user._id });
    res.status(200).json({ message: 'Media asset deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
