import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import archiver from 'archiver';
import { getDBStatus } from '../config/db.js';
import { mockStore } from '../models/mockStore.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import BulkMediaReservation from '../models/BulkMediaReservation.js';
import BulkAgentPlan from '../models/BulkAgentPlan.js';
import { countPlanSourceOccurrences } from '../services/bulkAgentService.js';
import CampaignChannel from '../models/CampaignChannel.js';
import Campaign from '../models/Campaign.js';
import SocialAccount from '../models/SocialAccount.js';
import { uploadFile, deleteFile, createPresignedUploadUrl, fileExists, getStorageUrl, isR2DirectUploadAvailable } from '../services/r2Service.js';
import { protect, authorize } from '../middleware/auth.js';
import { getOriginalStorageKey, getThumbnailStorageKey } from '../utils/storageKeys.js';
import { generateThumbnailFromBuffer, ensureMediaThumbnail } from '../services/videoThumbnailService.js';
import { ensureDefaultCampaignFolders } from '../services/campaignFolderService.js';
import { analyzeMediaVideo } from '../services/videoAiService.js';
import path from 'path';
import { Readable } from 'node:stream';

const router = express.Router();
const ADMIN_ROLES = ['owner', 'admin'];
const MEDIA_PUBLIC_HOST = 'media.theeasypost.com';

const isTrustedMediaUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === MEDIA_PUBLIC_HOST
      || host.endsWith('.theeasypost.com')
      || host.endsWith('.r2.dev')
      || host.endsWith('.r2.cloudflarestorage.com')
      || host.endsWith('.blob.core.windows.net')
      || host.endsWith('.amazonaws.com')
      || host.endsWith('.googleusercontent.com')
      || host.endsWith('.cloudinary.com')
      || host.endsWith('.supabase.co')
      || host === 'localhost'
      || host === '127.0.0.1'
    );
  } catch {
    return false;
  }
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

const normalizeScope = (value) => (value === 'global' ? 'global' : 'campaign');
const getRequestedScope = (req) => normalizeScope(req.query.scope || req.body?.scope);
const isAdminRole = (req) => ADMIN_ROLES.includes(req.user?.role);

const requireGlobalPermission = (req, res) => {
  if (!isAdminRole(req)) {
    res.status(403).json({ message: 'Only owners and admins can manage global media.' });
    return false;
  }
  return true;
};

const getReadableScopeQuery = (campaignId, requestedScope = 'campaign') => {
  if (requestedScope === 'global') {
    return { scope: 'global' };
  }

  return {
    $or: [
      { campaignId },
      { scope: 'global' },
    ],
  };
};

const getWritableScope = (req, res) => {
  const requestedScope = getRequestedScope(req);
  if (requestedScope === 'global' && !requireGlobalPermission(req, res)) {
    return null;
  }
  return requestedScope;
};

const findReadableFolder = async (req, res, folderId, campaignId) => {
  const folder = await Folder.findOne({
    _id: folderId,
    ...getReadableScopeQuery(campaignId),
  });

  if (!folder) {
    res.status(404).json({ message: 'Folder not found' });
    return null;
  }

  return folder;
};

const getDescendantFolderIds = async (rootFolderId, scope, campaignId) => {
  const folderIds = [rootFolderId];
  const queue = [rootFolderId];

  while (queue.length > 0) {
    const parentFolderId = queue.shift();
    const children = await Folder.find({
      parentFolderId,
      ...(scope === 'global' ? { scope: 'global' } : { campaignId }),
    }).select('_id');
    children.forEach((child) => {
      const childId = child._id;
      folderIds.push(childId);
      queue.push(childId);
    });
  }

  return folderIds;
};

const getUploadScopeContext = async (req, res, folderId) => {
  const requestedScope = getWritableScope(req, res);
  if (!requestedScope) return null;

  const campaignId = requestedScope === 'global' ? null : requireCampaignId(req, res);
  if (requestedScope === 'campaign' && !campaignId) return null;

  const resolvedFolderId = folderId && folderId !== 'null' ? folderId : null;
  if (!resolvedFolderId) {
    return { scope: requestedScope, campaignId, folderId: null };
  }

  const lookupCampaignId = campaignId || getActiveCampaignId(req);
  const folder = await findReadableFolder(req, res, resolvedFolderId, lookupCampaignId);
  if (!folder) return null;

  const folderScope = normalizeScope(folder.scope);
  if (folderScope === 'global' && !requireGlobalPermission(req, res)) {
    return null;
  }

  return {
    scope: folderScope,
    campaignId: folderScope === 'global' ? null : folder.campaignId,
    folderId: resolvedFolderId,
  };
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

const parseUploadOrder = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const parseUploadBatchCreatedAt = (value) => {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const parseSourceUsage = (value) => {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const normalizeMediaId = (mediaId) => {
    const id = String(mediaId || '').trim();
    return mongoose.Types.ObjectId.isValid(id) ? id : null;
  };

  return {
    firstVideoId: normalizeMediaId(parsed.firstVideoId),
    secondVideoId: normalizeMediaId(parsed.secondVideoId),
    musicId: normalizeMediaId(parsed.musicId),
    text: String(parsed.text || '').trim(),
  };
};

const releaseCompletedSourceReservations = async ({ userId, campaignId, sourceUsage }) => {
  if (!campaignId) return 0;
  const sourceMediaIds = [...new Set([
    sourceUsage?.firstVideoId,
    sourceUsage?.secondVideoId,
    sourceUsage?.musicId,
  ].map((value) => String(value || '')).filter(Boolean))];
  if (sourceMediaIds.length === 0) return 0;
  const reservationQuery = {
    userId,
    campaignId,
    sourceMediaId: { $in: sourceMediaIds },
    expiresAt: { $gt: new Date() },
  };
  const reservations = await BulkMediaReservation.find(reservationQuery)
    .select('_id planId sourceMediaId')
    .lean();
  const candidatePlanIds = [...new Set(reservations.map((reservation) => String(reservation.planId)))];
  const plans = candidatePlanIds.length > 0
    ? await BulkAgentPlan.find({ _id: { $in: candidatePlanIds } }).select('assignments').lean()
    : [];
  const plansById = new Map(plans.map((plan) => [String(plan._id), plan]));
  const releasableReservations = reservations.filter((reservation) => {
    const plan = plansById.get(String(reservation.planId));
    return !plan || countPlanSourceOccurrences(plan, reservation.sourceMediaId) <= 1;
  });
  if (releasableReservations.length === 0) return 0;
  const result = await BulkMediaReservation.deleteMany({
    _id: { $in: releasableReservations.map((reservation) => reservation._id) },
  });
  const planIds = [...new Set(releasableReservations.map((reservation) => String(reservation.planId)))];
  for (const planId of planIds) {
    const remainingCount = await BulkMediaReservation.countDocuments({ planId });
    if (remainingCount === 0) {
      await BulkAgentPlan.updateOne(
        { _id: planId, userId, campaignId, status: 'applied' },
        {
          $set: {
            status: 'released',
            expiresAt: new Date(Date.now() + (5 * 60 * 1000)),
          },
        },
      );
    }
  }
  return Number(result.deletedCount || 0);
};

const getMediaTypeFromMime = (mimeType = '') => {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/') || mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') return 'audio';
  return 'image';
};

const getSafeDownloadName = (value, fallback = 'media-download') => {
  const cleaned = String(value || '')
    .replace(/[\r\n]/g, '')
    .replace(/[\\/]/g, '-')
    .trim();
  return cleaned || fallback;
};

const streamMediaDownload = async (media, res) => {
  const upstream = await fetch(media.url);
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Storage returned HTTP ${upstream.status || 'unknown'}.`);
  }

  const fileName = getSafeDownloadName(media.name);
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const contentLength = upstream.headers.get('content-length');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (contentLength) res.setHeader('Content-Length', contentLength);

  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', (error) => {
    console.error(`Media download stream failed for ${media._id || media.name}:`, error);
    if (!res.headersSent) res.status(502).json({ message: 'The media file could not be downloaded.' });
    else res.destroy(error);
  });
  stream.pipe(res);
};

const canUserDownloadMedia = async (media, user, campaignAccessCache = new Map()) => {
  if (!media || !user) return false;
  if (ADMIN_ROLES.includes(user.role)) return true;
  if (String(media.userId || '') === String(user._id || '')) return true;
  if (normalizeScope(media.scope) === 'global') return true;

  const mediaAccountIds = (media.socialAccountIds || []).map((accountId) => String(accountId));
  if (mediaAccountIds.length > 0) {
    const ownedAccount = await SocialAccount.exists({
      _id: { $in: mediaAccountIds },
      userId: user._id,
    });
    if (ownedAccount) return true;
  }

  const campaignId = String(media.campaignId || '');
  if (!campaignId) return false;
  if (campaignAccessCache.has(campaignId)) return campaignAccessCache.get(campaignId);

  const userEmail = String(user.email || '').trim().toLowerCase();
  const identityAccess = [
    { createdBy: user._id },
    { 'channels.assignedHandlerUserId': user._id },
  ];
  if (userEmail) {
    identityAccess.push(
      { mainEmail: userEmail },
      { 'channels.assignedHandlerEmail': userEmail }
    );
  }
  const allowed = Boolean(await Campaign.exists({
    _id: media.campaignId,
    $or: identityAccess,
  }));
  campaignAccessCache.set(campaignId, allowed);
  return allowed;
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

// Multer in-memory storage configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max limit
  }
});

router.options('/proxy', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendStatus(204);
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
    // Only allow proxying from trusted public media domains.
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    
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
      const folders = mockStore.folders.map((folder) => {
        const folderMedia = mockStore.media.filter(
          (item) => String(item.folderId || '') === String(folder._id),
        );
        const previewMedia = folderMedia.find((item) => (
          ['image', 'video'].includes(item.type) && (item.thumbnailUrl || item.url)
        ));
        const coverMedia = folder.coverMediaId
          ? folderMedia.find((item) => String(item._id) === String(folder.coverMediaId) && item.type === 'image')
          : null;
        return {
          ...folder,
          itemCount: folderMedia.length,
          coverMedia: coverMedia || null,
          previewMedia: previewMedia || null,
        };
      });
      return res.status(200).json(folders);
    }
    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    if (getRequestedScope(req) !== 'global') {
      await ensureDefaultCampaignFolders(campaignId, req.user?._id);
    }
    const folders = await Folder.find(
      getReadableScopeQuery(campaignId, getRequestedScope(req)),
    ).lean();
    const folderIds = folders.map((folder) => folder._id);
    const coverMediaIds = folders.map((folder) => folder.coverMediaId).filter(Boolean);
    const [countSummaries, previewSummaries, coverMediaItems, subfolderCountSummaries] = folderIds.length > 0
      ? await Promise.all([
        Media.aggregate([
          { $match: { folderId: { $in: folderIds } } },
          { $group: { _id: '$folderId', itemCount: { $sum: 1 } } },
        ]),
        Media.aggregate([
          {
            $match: {
              folderId: { $in: folderIds },
              type: { $in: ['image', 'video'] },
            },
          },
          { $sort: { uploadBatchCreatedAt: -1, createdAt: -1 } },
          {
            $group: {
              _id: '$folderId',
              previewMedia: {
                $first: {
                  _id: '$_id',
                  name: '$name',
                  type: '$type',
                  url: '$url',
                  thumbnailUrl: '$thumbnailUrl',
                },
              },
            },
          },
        ]),
        coverMediaIds.length > 0
          ? Media.find({
              _id: { $in: coverMediaIds },
              folderId: { $in: folderIds },
              type: 'image',
            }).select('_id name type url thumbnailUrl').lean()
          : [],
        Folder.aggregate([
          { $match: { parentFolderId: { $in: folderIds } } },
          { $group: { _id: '$parentFolderId', subfolderCount: { $sum: 1 } } },
        ]),
      ])
      : [[], [], [], []];
    const countsByFolderId = new Map(
      countSummaries.map((summary) => [String(summary._id), Number(summary.itemCount || 0)]),
    );
    const subfolderCountsByFolderId = new Map(
      subfolderCountSummaries.map((summary) => [String(summary._id), Number(summary.subfolderCount || 0)]),
    );
    const previewsByFolderId = new Map(
      previewSummaries.map((summary) => [String(summary._id), summary.previewMedia]),
    );
    const coverMediaById = new Map(
      coverMediaItems.map((item) => [String(item._id), item]),
    );

    const childFoldersByParentId = new Map();
    const subfoldersByParentId = new Map();
    folders.forEach((folder) => {
      if (folder.parentFolderId) {
        const parentId = String(folder.parentFolderId);
        subfoldersByParentId.set(parentId, (subfoldersByParentId.get(parentId) || 0) + 1);
        if (!childFoldersByParentId.has(parentId)) {
          childFoldersByParentId.set(parentId, []);
        }
        childFoldersByParentId.get(parentId).push(String(folder._id));
      }
    });

    const getFolderPreviewMedia = (folderId) => {
      const directPreview = previewsByFolderId.get(folderId);
      if (directPreview) return directPreview;
      const childIds = childFoldersByParentId.get(folderId) || [];
      for (const childId of childIds) {
        const childPreview = previewsByFolderId.get(childId);
        if (childPreview) return childPreview;
      }
      return null;
    };

    res.status(200).json(folders.map((folder) => {
      const folderId = String(folder._id);
      return {
        ...folder,
        itemCount: countsByFolderId.get(folderId) || 0,
        subfolderCount: subfoldersByParentId.get(folderId) || 0,
        coverMedia: coverMediaById.get(String(folder.coverMediaId || '')) || null,
        previewMedia: getFolderPreviewMedia(folderId),
      };
    }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create a new folder
// @route   POST /api/media/folders
// @access  Private (Owner, Admin, Editor)
router.post('/folders', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { name, parentFolderId, kind, carouselCaption, carouselOrder, tags } = req.body;
  const requestedScope = getWritableScope(req, res);
  if (!requestedScope) return;

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const newFolder = {
        _id: `f_${Date.now()}`,
        name,
        scope: requestedScope,
        parentFolderId: parentFolderId || null,
        kind: kind === 'carousel_set' ? 'carousel_set' : 'folder',
        carouselCaption: carouselCaption || '',
        carouselOrder: Array.isArray(carouselOrder) ? carouselOrder : [],
        tags: parseTagList(tags),
        createdAt: new Date(),
      };
      mockStore.folders.push(newFolder);
      return res.status(201).json(newFolder);
    }

    const campaignId = requestedScope === 'global' ? null : requireCampaignId(req, res);
    if (requestedScope === 'campaign' && !campaignId) return;

    let parentFolder = null;
    if (parentFolderId) {
      parentFolder = await findReadableFolder(req, res, parentFolderId, campaignId || getActiveCampaignId(req));
      if (!parentFolder) return;
      if (normalizeScope(parentFolder.scope) === 'global' && !requireGlobalPermission(req, res)) return;
    }

    const folderScope = parentFolder ? normalizeScope(parentFolder.scope) : requestedScope;
    const folder = await Folder.create({
      userId: req.user._id,
      campaignId: folderScope === 'global' ? null : campaignId,
      scope: folderScope,
      name,
      parentFolderId: parentFolderId || null,
      kind: kind === 'carousel_set' ? 'carousel_set' : 'folder',
      carouselCaption: carouselCaption || '',
      carouselOrder: Array.isArray(carouselOrder) ? carouselOrder : [],
      tags: parseTagList(tags),
    });
    res.status(201).json(folder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Update carousel set metadata
// @route   PUT /api/media/folders/:id/carousel
// @access  Private (Owner, Admin, Editor)
router.put('/folders/:id/carousel', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;
  const carouselCaption = String(req.body?.carouselCaption || '');
  const carouselOrder = Array.isArray(req.body?.carouselOrder) ? req.body.carouselOrder : [];

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const folder = mockStore.folders.find(f => f._id === id);
      if (!folder) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      folder.kind = 'carousel_set';
      folder.carouselCaption = carouselCaption;
      folder.carouselOrder = carouselOrder;
      folder.updatedAt = new Date();
      return res.status(200).json(folder);
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;

    const existingFolder = await findReadableFolder(req, res, id, campaignId);
    if (!existingFolder) return;
    const folderScope = normalizeScope(existingFolder.scope);
    if (folderScope === 'global' && !requireGlobalPermission(req, res)) return;

    if (carouselOrder.length > 0) {
      const mediaCount = await Media.countDocuments({
        _id: { $in: carouselOrder },
        folderId: id,
        ...(folderScope === 'global' ? { scope: 'global' } : { campaignId }),
      });
      if (mediaCount !== carouselOrder.length) {
        return res.status(400).json({ message: 'Carousel order contains media outside this folder.' });
      }
    }

    const folder = await Folder.findOneAndUpdate(
      { _id: id, ...(folderScope === 'global' ? { scope: 'global' } : { campaignId }) },
      {
        kind: 'carousel_set',
        carouselCaption,
        carouselOrder,
      },
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

// @desc    Update folder metadata
// @route   PUT /api/media/folders/:id
// @access  Private (Owner, Admin, Editor)
router.put('/folders/:id', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
  const { id } = req.params;
  const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, 'name');
  const hasTags = Object.prototype.hasOwnProperty.call(req.body || {}, 'tags');
  const hasScope = Object.prototype.hasOwnProperty.call(req.body || {}, 'scope');
  const hasCoverMediaId = Object.prototype.hasOwnProperty.call(req.body || {}, 'coverMediaId');
  const nextName = hasName ? String(req.body?.name || '').trim() : '';
  const nextScope = normalizeScope(req.body?.scope);
  const nextCoverMediaId = hasCoverMediaId && req.body?.coverMediaId
    ? String(req.body.coverMediaId)
    : null;

  if (!hasName && !hasTags && !hasScope && !hasCoverMediaId) {
    return res.status(400).json({ message: 'No folder updates were provided.' });
  }

  if (hasName && !nextName) {
    return res.status(400).json({ message: 'Folder name is required.' });
  }

  try {
    const isConnected = getDBStatus();
    if (!isConnected) {
      const folder = mockStore.folders.find(f => f._id === id);
      if (!folder) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      if (hasName) folder.name = nextName;
      if (hasTags) folder.tags = parseTagList(req.body.tags);
      if (hasCoverMediaId) {
        const coverMedia = nextCoverMediaId
          ? mockStore.media.find((item) => (
              String(item._id) === nextCoverMediaId
              && String(item.folderId || '') === String(id)
              && item.type === 'image'
            ))
          : null;
        if (nextCoverMediaId && !coverMedia) {
          return res.status(400).json({ message: 'Folder cover must be an image inside this folder.' });
        }
        folder.coverMediaId = nextCoverMediaId;
      }
      if (hasScope) {
        if (nextScope === 'global' && !requireGlobalPermission(req, res)) return;
        folder.scope = nextScope;
        folder.campaignId = nextScope === 'global' ? null : folder.campaignId;
        mockStore.media = mockStore.media.map((mediaItem) => (
          mediaItem.folderId === id
            ? { ...mediaItem, scope: nextScope, campaignId: nextScope === 'global' ? null : mediaItem.campaignId }
            : mediaItem
        ));
      }
      folder.updatedAt = new Date();
      return res.status(200).json(folder);
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const existingFolder = await findReadableFolder(req, res, id, campaignId);
    if (!existingFolder) return;
    const folderScope = normalizeScope(existingFolder.scope);
    if (folderScope === 'global' && !requireGlobalPermission(req, res)) return;
    if (hasScope && nextScope === 'global' && !requireGlobalPermission(req, res)) return;

    if (nextCoverMediaId) {
      const coverMedia = await Media.findOne({
        _id: nextCoverMediaId,
        folderId: id,
        type: 'image',
        ...(folderScope === 'global' ? { scope: 'global' } : { campaignId }),
      }).select('_id');
      if (!coverMedia) {
        return res.status(400).json({ message: 'Folder cover must be an image inside this folder.' });
      }
    }

    const updates = {};
    if (hasName) updates.name = nextName;
    if (hasTags) updates.tags = parseTagList(req.body.tags);
    if (hasCoverMediaId) updates.coverMediaId = nextCoverMediaId;
    if (hasScope) {
      updates.scope = nextScope;
      if (nextScope === 'global') {
        updates.campaignId = null;
      } else {
        updates.campaignId = campaignId;
      }
    }

    const folder = await Folder.findOneAndUpdate(
      { _id: id, ...(folderScope === 'global' ? { scope: 'global' } : { campaignId }) },
      updates,
      { new: true }
    );

    if (!folder) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    if (hasScope) {
      const folderIds = await getDescendantFolderIds(id, folderScope, campaignId);
      const previousScopeQuery = folderScope === 'global' ? { scope: 'global' } : { campaignId };
      const nextCampaignId = nextScope === 'global' ? null : campaignId;
      await Folder.updateMany(
        { _id: { $in: folderIds }, ...previousScopeQuery },
        { scope: nextScope, campaignId: nextCampaignId }
      );
      await Media.updateMany(
        { folderId: { $in: folderIds }, ...previousScopeQuery },
        {
          scope: nextScope,
          campaignId: nextCampaignId,
          ...(nextScope === 'global' ? { socialAccountIds: [] } : {}),
        }
      );
      const updatedFolder = await Folder.findById(id);
      return res.status(200).json(updatedFolder);
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
      mockStore.media = mockStore.media.filter(m => m.folderId !== id);
      return res.status(200).json({ message: 'Folder deleted successfully' });
    }

    const campaignId = requireCampaignId(req, res);
    if (!campaignId) return;
    const folder = await findReadableFolder(req, res, id, campaignId);
    if (!folder) {
      return;
    }
    const folderScope = normalizeScope(folder.scope);
    if (folderScope === 'global' && !requireGlobalPermission(req, res)) return;

    const mediaQuery = {
      folderId: id,
      ...(folderScope === 'global' ? { scope: 'global' } : { campaignId }),
    };
    const mediaItems = await Media.find(mediaQuery).select('storageKey thumbnailStorageKey');
    for (const mediaItem of mediaItems) {
      await deleteFile(mediaItem.storageKey);
      if (mediaItem.thumbnailStorageKey) {
        await deleteFile(mediaItem.thumbnailStorageKey);
      }
    }

    await Folder.deleteOne({ _id: id, ...(folderScope === 'global' ? { scope: 'global' } : { campaignId }) });
    await Media.deleteMany(mediaQuery);
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
      
      filtered.sort((a, b) => {
        const batchA = new Date(a.uploadBatchCreatedAt || a.createdAt).getTime();
        const batchB = new Date(b.uploadBatchCreatedAt || b.createdAt).getTime();
        if (batchA !== batchB) return batchB - batchA;
        const orderA = Number.isFinite(Number(a.uploadOrder)) ? Number(a.uploadOrder) : Number.MAX_SAFE_INTEGER;
        const orderB = Number.isFinite(Number(b.uploadOrder)) ? Number(b.uploadOrder) : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      
      if (querySkip !== undefined && queryLimit !== undefined) {
        filtered = filtered.slice(querySkip, querySkip + queryLimit);
      }
      
      return res.status(200).json(filtered);
    }
    const includeSubfolders = String(req.query.includeSubfolders || '').toLowerCase() === 'true';
    const query = {};

    const campaignId = requireCampaignId(req, res);
    if (!campaignId && getRequestedScope(req) !== 'global') return;
    Object.assign(query, getReadableScopeQuery(campaignId, getRequestedScope(req)));

    if (folderId) {
      if (folderId === 'root') {
        query.folderId = null;
      } else if (includeSubfolders) {
        const folder = await Folder.findById(folderId);
        const folderScope = normalizeScope(folder?.scope);
        const descendantIds = await getDescendantFolderIds(folderId, folderScope, campaignId);
        query.folderId = { $in: descendantIds };
      } else {
        query.folderId = folderId;
      }
    }
    if (tag) {
      query.tags = tag.toLowerCase();
    }
    if (accountId) {
      const scopeOr = query.$or;
      delete query.$or;
      query.$and = [
        ...(scopeOr ? [{ $or: scopeOr }] : []),
        {
          $or: [
            { socialAccountIds: accountId },
            { socialAccountIds: { $size: 0 } },
          ],
        },
      ];
    }

    let dbQuery = Media.find(query)
      .populate('socialAccountIds', 'name username platform avatarUrl isConnected')
      .sort({ uploadBatchCreatedAt: -1, uploadOrder: 1, createdAt: -1 });

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
    const scopeContext = await getUploadScopeContext(req, res, folderId);
    if (!scopeContext) return;
    const mediaId = new Media()._id;
    const storageKey = getOriginalStorageKey({
      userId: req.user._id,
      folderId: scopeContext.folderId,
      mediaId,
      originalName: name,
    });
    const upload = await createPresignedUploadUrl({
      storageKey,
      contentType,
    });

    const mediaType = getMediaTypeFromMime(contentType);
    let thumbnailInfo = {};
    if (mediaType === 'video') {
      const thumbnailStorageKey = getThumbnailStorageKey({
        userId: req.user._id,
        folderId: scopeContext.folderId,
        mediaId,
      });
      const thumbUpload = await createPresignedUploadUrl({
        storageKey: thumbnailStorageKey,
        contentType: 'image/jpeg',
      });
      thumbnailInfo = {
        thumbnailStorageKey,
        thumbnailUrl: thumbUpload.url,
        thumbnailUploadUrl: thumbUpload.uploadUrl,
      };
    }

    res.status(200).json({
      mediaId,
      storageKey,
      url: upload.url,
      uploadUrl: upload.uploadUrl,
      expiresIn: upload.expiresIn,
      ...thumbnailInfo,
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
      thumbnailStorageKey: passedThumbKey,
      thumbnailUrl: passedThumbUrl,
      caption = '',
      tags,
      size,
      aiMode,
      uploadBatchId = '',
      uploadBatchCreatedAt,
      uploadOrder,
    } = req.body || {};

    if (!mediaId || !name || !storageKey) {
      return res.status(400).json({ message: 'Media id, file name, and storage key are required.' });
    }

    try {
      const scopeContext = await getUploadScopeContext(req, res, folderId);
      if (!scopeContext) return;
      const requestedAccountIds = parseIdList(req.body.socialAccountIds);
      let socialAccountIds = [];
      if (scopeContext.scope === 'global') {
        if (requestedAccountIds.length > 0) {
          return res.status(400).json({ message: 'Global media cannot be restricted to campaign channels.' });
        }
      } else {
        socialAccountIds = await getValidSocialAccountIds(requestedAccountIds, scopeContext.campaignId);
        if (requestedAccountIds.length > 0 && socialAccountIds.length !== requestedAccountIds.length) {
          return res.status(400).json({ message: 'One or more selected publishing channels are not connected.' });
        }
      }

      const expectedStorageKey = getOriginalStorageKey({
        userId: req.user._id,
        folderId: scopeContext.folderId,
        mediaId,
        originalName: name,
      });
      if (storageKey !== expectedStorageKey) {
        return res.status(400).json({ message: 'Upload storage key does not match this media asset.' });
      }

      const existing = await Media.findOne({
        _id: mediaId,
        ...(scopeContext.scope === 'global' ? { scope: 'global' } : { campaignId: scopeContext.campaignId }),
      })
        .populate('socialAccountIds', 'name username platform avatarUrl isConnected');
      if (existing) {
        return res.status(200).json(existing);
      }

      const exists = await fileExists(storageKey);
      if (!exists) {
        return res.status(400).json({ message: 'Uploaded file was not found in R2.' });
      }

      const mediaType = getMediaTypeFromMime(contentType);
      let thumbnailStorageKey = '';
      let thumbnailUrl = '';
      let thumbnailGeneratedAt = undefined;

      if (mediaType === 'video') {
        const expectedThumbKey = getThumbnailStorageKey({
          userId: req.user._id,
          folderId: scopeContext.folderId,
          mediaId,
        });

        if (passedThumbKey && passedThumbKey === expectedThumbKey) {
          thumbnailStorageKey = passedThumbKey;
          thumbnailUrl = passedThumbUrl || getStorageUrl(passedThumbKey);
          thumbnailGeneratedAt = new Date();
        } else {
          const thumbExists = await fileExists(expectedThumbKey);
          if (thumbExists) {
            thumbnailStorageKey = expectedThumbKey;
            thumbnailUrl = getStorageUrl(expectedThumbKey);
            thumbnailGeneratedAt = new Date();
          }
        }
      }

      const media = await Media.create({
        _id: mediaId,
        userId: req.user._id,
        campaignId: scopeContext.campaignId,
        scope: scopeContext.scope,
        folderId: scopeContext.folderId,
        socialAccountIds,
        name,
        type: mediaType,
        url: getStorageUrl(storageKey),
        storageKey,
        thumbnailUrl,
        thumbnailStorageKey,
        thumbnailGeneratedAt,
        caption: caption || '',
        uploadBatchId: String(uploadBatchId || ''),
        uploadBatchCreatedAt: parseUploadBatchCreatedAt(uploadBatchCreatedAt),
        uploadOrder: parseUploadOrder(uploadOrder),
        tags: parseTagList(tags),
        size: Number(size) || undefined,
      });

      if (mediaType === 'video') {
        if (!thumbnailUrl) {
          // Trigger background fallback to extract frame using ffmpeg
          ensureMediaThumbnail(media._id).catch(() => {});
        }
        media.aiStatus = 'processing';
        await media.save();
        // Asynchronously analyze with Gemini (non-blocking)
        const explicitMode = aiMode === 'app_showcase' || aiMode === 'reaction' ? aiMode : undefined;
        analyzeMediaVideo(media._id, { mode: explicitMode }).catch((err) => {
          console.error(`[media.js] Failed to analyze video ${media._id}:`, err);
        });
      }

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

    const {
      folderId,
      tags,
      caption,
      sourceUsage,
      aiMode,
      uploadBatchId = '',
      uploadBatchCreatedAt,
      uploadOrder,
    } = req.body;
    const requestedAccountIds = parseIdList(req.body.socialAccountIds);
    const mimeType = req.file.mimetype;
    const mediaType = getMediaTypeFromMime(mimeType);

    try {
      const tagList = parseTagList(tags);
      const parsedSourceUsage = parseSourceUsage(sourceUsage);
      const isConnected = getDBStatus();
      const scopeContext = isConnected
        ? await getUploadScopeContext(req, res, folderId)
        : {
            scope: getRequestedScope(req),
            campaignId: getRequestedScope(req) === 'global' ? null : getActiveCampaignId(req),
            folderId: folderId && folderId !== 'null' ? folderId : null,
          };
      if (!scopeContext) return;

      // Auto-assign showcase uploads to campaign's App Showcase folder if folderId is not specified
      if (!scopeContext.folderId && scopeContext.campaignId) {
        const isShowcaseUpload = aiMode === 'app_showcase' || tagList.some((t) => t === 'app-showcase' || t === 'showcase' || t === 'promo');
        if (isShowcaseUpload) {
          if (isConnected) {
            const folderMap = await ensureDefaultCampaignFolders(scopeContext.campaignId, req.user?._id);
            const showcaseFolder = folderMap?.['App Showcase'] || await Folder.findOne({
              campaignId: scopeContext.campaignId,
              scope: 'campaign',
              $or: [{ name: /^app showcase$/i }, { tags: 'app-showcase' }, { tags: 'promo' }],
            });
            if (showcaseFolder?._id) {
              scopeContext.folderId = showcaseFolder._id;
            }
          } else {
            const mockFolder = mockStore.folders.find((f) => (
              String(f.campaignId || '') === String(scopeContext.campaignId) &&
              (/app showcase/i.test(f.name) || (f.tags || []).includes('app-showcase'))
            ));
            if (mockFolder?._id) {
              scopeContext.folderId = mockFolder._id;
            }
          }
        }
      }
      let socialAccountIds = requestedAccountIds;

      if (isConnected) {
        if (scopeContext.scope === 'global') {
          if (requestedAccountIds.length > 0) {
            return res.status(400).json({ message: 'Global media cannot be restricted to campaign channels.' });
          }
          socialAccountIds = [];
        } else {
          socialAccountIds = await getValidSocialAccountIds(requestedAccountIds, scopeContext.campaignId);
          if (requestedAccountIds.length > 0 && socialAccountIds.length !== requestedAccountIds.length) {
            return res.status(400).json({ message: 'One or more selected publishing channels are not connected.' });
          }
        }
      }

      if (!isConnected) {
        const mediaId = `m_${Date.now()}`;
        const storageKey = getOriginalStorageKey({
          userId: req.user?._id || 'mock-user',
          folderId: scopeContext.folderId,
          mediaId,
          originalName: req.file.originalname,
        });
        const { url } = await uploadFile({ ...req.file, storageKey });
        const newMedia = {
          _id: mediaId,
          campaignId: scopeContext.campaignId,
          scope: scopeContext.scope,
          folderId: scopeContext.folderId,
          name: req.file.originalname,
          type: mediaType,
          url,
          storageKey,
          caption: caption || '',
          sourceUsage: parsedSourceUsage,
          uploadBatchId: String(uploadBatchId || ''),
          uploadBatchCreatedAt: parseUploadBatchCreatedAt(uploadBatchCreatedAt),
          uploadOrder: parseUploadOrder(uploadOrder),
          socialAccountIds,
          tags: tagList,
          size: req.file.size,
          createdAt: new Date(),
        };
        mockStore.media.push(newMedia);
        return res.status(201).json(newMedia);
      }

      const mediaId = new Media()._id;
      const storageKey = getOriginalStorageKey({
        userId: req.user._id,
        folderId: scopeContext.folderId,
        mediaId,
        originalName: req.file.originalname,
      });
      const { url } = await uploadFile({ ...req.file, storageKey });

      let thumbnailUrl = '';
      let thumbnailStorageKey = '';
      let thumbnailGeneratedAt = undefined;

      if (mediaType === 'video') {
        const thumbResult = await generateThumbnailFromBuffer({
          buffer: req.file.buffer,
          extension: path.extname(req.file.originalname),
          userId: req.user._id,
          folderId: scopeContext.folderId,
          mediaId,
        });
        if (thumbResult) {
          thumbnailUrl = thumbResult.thumbnailUrl;
          thumbnailStorageKey = thumbResult.thumbnailStorageKey;
          thumbnailGeneratedAt = thumbResult.thumbnailGeneratedAt;
        }
      }

      const media = await Media.create({
        _id: mediaId,
        userId: req.user._id,
        campaignId: scopeContext.campaignId,
        scope: scopeContext.scope,
        folderId: scopeContext.folderId,
        socialAccountIds,
        name: req.file.originalname,
        type: mediaType,
        url,
        storageKey,
        thumbnailUrl,
        thumbnailStorageKey,
        thumbnailGeneratedAt,
        caption: caption || '',
        sourceUsage: parsedSourceUsage,
        uploadBatchId: String(uploadBatchId || ''),
        uploadBatchCreatedAt: parseUploadBatchCreatedAt(uploadBatchCreatedAt),
        uploadOrder: parseUploadOrder(uploadOrder),
        tags: tagList,
        size: req.file.size,
      });

      // Media.sourceUsage is durable before reservations are released, so the
      // cooldown index still prevents reuse even if the reservation cleanup fails.
      try {
        await releaseCompletedSourceReservations({
          userId: req.user._id,
          campaignId: scopeContext.campaignId,
          sourceUsage: parsedSourceUsage,
        });
      } catch (reservationError) {
        console.error('Generated media saved, but source reservation cleanup failed:', reservationError);
      }

      const populated = await Media.findById(media._id)
        .populate('socialAccountIds', 'name username platform avatarUrl isConnected');

      if (mediaType === 'video') {
        media.aiStatus = 'processing';
        await media.save();
        const explicitMode = aiMode === 'app_showcase' || aiMode === 'reaction' ? aiMode : undefined;
        analyzeMediaVideo(media._id, { mode: explicitMode }).catch((err) => {
          console.error(`[media.js] Failed to analyze video ${media._id}:`, err);
        });
      }

      res.status(201).json(populated);
    } catch (error) {
      console.error('Upload error in route:', error);
      res.status(500).json({ message: error.message });
    }
  });

  // @desc    Get AI analysis status/results for one video media asset
  // @route   GET /api/media/:id/analyze-ai
  // @access  Private
  router.get('/:id/analyze-ai', protect, async (req, res) => {
    const { id } = req.params;

    try {
      const isConnected = getDBStatus();
      if (!isConnected) {
        const mediaItem = mockStore.media.find((item) => String(item._id) === String(id));
        if (!mediaItem) {
          return res.status(404).json({ message: 'Media not found' });
        }
        return res.status(200).json({
          _id: mediaItem._id,
          type: mediaItem.type,
          tags: mediaItem.tags || [],
          aiStatus: mediaItem.aiStatus || 'pending',
          aiError: mediaItem.aiError || '',
          aiProcessedAt: mediaItem.aiProcessedAt,
          aiAnalysis: mediaItem.aiAnalysis,
        });
      }

      const campaignId = requireCampaignId(req, res);
      if (!campaignId) return;

      const media = await Media.findOne({
        _id: id,
        ...getReadableScopeQuery(campaignId),
      })
        .select('_id name type url thumbnailUrl size tags aiStatus aiError aiProcessedAt aiAnalysis')
        .lean();

      if (!media) {
        return res.status(404).json({ message: 'Media not found' });
      }
      if (media.type !== 'video') {
        return res.status(400).json({ message: 'AI video analysis is only available for video files.' });
      }

      return res.status(200).json(media);
    } catch (error) {
      console.error('Error refreshing AI analysis status:', error);
      return res.status(500).json({ message: error.message || 'Failed to refresh AI analysis status.' });
    }
  });

  // @desc    Trigger or re-run AI analysis on a video media asset
  // @route   POST /api/media/:id/analyze-ai
  // @access  Private (Owner, Admin, Editor)
  router.post('/:id/analyze-ai', protect, authorize('owner', 'admin', 'editor'), async (req, res) => {
    const { id } = req.params;
    try {
      const campaignId = requireCampaignId(req, res);
      if (!campaignId) return;
      const media = await Media.findOne({
        _id: id,
        ...getReadableScopeQuery(campaignId),
      });
      if (!media) {
        return res.status(404).json({ message: 'Media not found' });
      }
      if (media.type !== 'video') {
        return res.status(400).json({ message: 'AI video analysis is only available for video files.' });
      }

      media.aiStatus = 'processing';
      media.aiError = '';
      await media.save();

      // Trigger analysis asynchronously in background (auto-resolving mode if not explicitly provided)
      const explicitMode = req.body?.mode === 'app_showcase' || req.body?.mode === 'reaction'
        ? req.body.mode
        : undefined;
      analyzeMediaVideo(media._id, { mode: explicitMode }).catch((err) => {
        console.error(`[media.js] Manual AI analysis failed for ${media._id}:`, err);
      });

      res.status(200).json({ message: 'AI video analysis started', media });
    } catch (error) {
      console.error('Error starting AI analysis:', error);
      res.status(500).json({ message: error.message || 'Failed to start AI analysis.' });
    }
  });

// @desc    Download selected media assets as a ZIP archive
// @route   POST /api/media/download-batch
// @access  Private
router.post('/download-batch', protect, async (req, res) => {
  const requestedIds = [...new Set(
    (Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : [])
      .map((mediaId) => String(mediaId || '').trim())
      .filter(Boolean)
  )];

  if (requestedIds.length === 0) {
    return res.status(400).json({ message: 'Select at least one media file to download.' });
  }
  if (requestedIds.length > 50) {
    return res.status(400).json({ message: 'You can download up to 50 media files at once.' });
  }

  try {
    const isConnected = getDBStatus();
    let mediaItems;

    if (!isConnected) {
      const mediaById = new Map(mockStore.media.map((item) => [String(item._id), item]));
      mediaItems = requestedIds.map((mediaId) => mediaById.get(mediaId)).filter(Boolean);
    } else {
      if (requestedIds.some((mediaId) => !mongoose.Types.ObjectId.isValid(mediaId))) {
        return res.status(400).json({ message: 'One or more selected media IDs are invalid.' });
      }

      const foundMedia = await Media.find({ _id: { $in: requestedIds } }).lean();
      const mediaById = new Map(foundMedia.map((item) => [String(item._id), item]));
      mediaItems = requestedIds.map((mediaId) => mediaById.get(mediaId)).filter(Boolean);
    }

    if (mediaItems.length !== requestedIds.length) {
      return res.status(404).json({ message: 'One or more selected media files were not found.' });
    }

    if (isConnected) {
      const campaignAccessCache = new Map();
      for (const media of mediaItems) {
        if (!await canUserDownloadMedia(media, req.user, campaignAccessCache)) {
          return res.status(403).json({ message: 'Access denied for one or more selected media files.' });
        }
      }
    }

    const requestedArchiveName = getSafeDownloadName(
      req.body?.archiveName,
      `media-download-${new Date().toISOString().slice(0, 10)}.zip`
    );
    const archiveName = requestedArchiveName.toLowerCase().endsWith('.zip')
      ? requestedArchiveName
      : `${requestedArchiveName}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    const archive = archiver('zip', { store: true });
    archive.on('warning', (error) => {
      console.warn('Media ZIP warning:', error);
    });
    archive.on('error', (error) => {
      console.error('Media ZIP stream failed:', error);
      if (!res.headersSent) res.status(500).json({ message: 'The selected media could not be downloaded.' });
      else res.destroy(error);
    });
    res.on('close', () => {
      if (!res.writableEnded) archive.abort();
    });
    archive.pipe(res);

    for (const [index, media] of mediaItems.entries()) {
      const upstream = await fetch(media.url);
      if (!upstream.ok || !upstream.body) {
        throw new Error(`Storage returned HTTP ${upstream.status || 'unknown'} for ${media.name || media._id}.`);
      }
      const entryName = `${String(index + 1).padStart(2, '0')}-${getSafeDownloadName(media.name, `media-${index + 1}`)}`;
      archive.append(Readable.fromWeb(upstream.body), { name: entryName });
    }

    await archive.finalize();
  } catch (error) {
    console.error('Batch media download failed:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: error.message || 'The selected media could not be downloaded.' });
    }
    res.destroy(error);
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
      await streamMediaDownload(mediaItem, res);
      return;
    }

    const media = await Media.findById(id).lean();
    if (!media) return res.status(404).json({ message: 'Media not found' });

    if (!await canUserDownloadMedia(media, req.user)) {
      return res.status(403).json({ message: 'Access denied for this media asset.' });
    }

    await streamMediaDownload(media, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ message: error.message || 'The media file could not be downloaded.' });
    }
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
    const existingMedia = await Media.findOne({
      _id: id,
      ...getReadableScopeQuery(campaignId),
    });
    if (!existingMedia) {
      return res.status(404).json({ message: 'Media not found' });
    }
    const mediaScope = normalizeScope(existingMedia.scope);
    if (mediaScope === 'global' && !requireGlobalPermission(req, res)) return;

    const media = await Media.findOneAndUpdate(
      { _id: id, ...(mediaScope === 'global' ? { scope: 'global' } : { campaignId }) },
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
    const media = await Media.findOne({
      _id: id,
      ...getReadableScopeQuery(campaignId),
    });
    if (!media) {
      return res.status(404).json({ message: 'Media not found' });
    }
    const mediaScope = normalizeScope(media.scope);
    if (mediaScope === 'global' && !requireGlobalPermission(req, res)) return;

    await deleteFile(media.storageKey);
    if (media.thumbnailStorageKey) {
      await deleteFile(media.thumbnailStorageKey);
    }
    await Media.deleteOne({ _id: id, ...(mediaScope === 'global' ? { scope: 'global' } : { campaignId }) });
    res.status(200).json({ message: 'Media asset deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
