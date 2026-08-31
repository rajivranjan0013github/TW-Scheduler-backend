import express from 'express';
import mongoose from 'mongoose';
import { getDBStatus } from '../config/db.js';
import { protect, authorize } from '../middleware/auth.js';
import BulkAgentPlan from '../models/BulkAgentPlan.js';
import BulkMediaReservation from '../models/BulkMediaReservation.js';
import Campaign from '../models/Campaign.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import { mockStore } from '../models/mockStore.js';
import {
  analyzeAudioIntent,
  BulkAvailabilityError,
  buildUsageIndex,
  createAssignments,
  deriveFallbackIntent,
  enrichCandidatesWithVisualContext,
  extractQuotedCaptionTexts,
  findAmbiguousFolderNames,
  generateCaptionsWithGemini,
  isDeterministicTaskPlan,
  mapStructuredMentionRoles,
  normalizeCurrentBoard,
  normalizeId,
  normalizeStructuredMentions,
  planWithGemini,
  resolveAudioFolderSelection,
  resolveDefaultPrimaryFolder,
  resolveDefaultSecondaryFolder,
  resolveRequestedCaptions,
  summarizeAssignments,
} from '../services/bulkAgentService.js';

const router = express.Router();
const PREVIEW_RESERVATION_MS = 30 * 60 * 1000;
const APPLIED_RESERVATION_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DISCARDED_PLAN_TTL_MS = 5 * 60 * 1000;
const TRANSITION_LEASE_MS = 2 * 60 * 1000;
const PLAN_RATE_WINDOW_MS = 60 * 1000;
const PLAN_RATE_LIMIT = 8;
const mockPlans = new Map();
const planRateBuckets = new Map();

const getAppliedReservationExpiry = (plan) => {
  const cooldownDays = Math.max(0, Math.min(3650, Number(plan?.cooldownDays) || 0));
  const hasReservedSources = (plan?.assignments || []).some((assignment) => (
    assignment?.video1?.mediaId || assignment?.video2?.mediaId || assignment?.audio?.mediaId
  ));
  return new Date(Date.now() + Math.max(
    APPLIED_RESERVATION_MS,
    hasReservedSources ? cooldownDays * DAY_MS : 0,
  ));
};

router.use(protect, authorize('owner', 'admin', 'editor'));

const planRateLimit = (req, res, next) => {
  const key = normalizeId(req.user);
  const now = Date.now();
  const bucket = (planRateBuckets.get(key) || []).filter((timestamp) => now - timestamp < PLAN_RATE_WINDOW_MS);
  if (bucket.length >= PLAN_RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((PLAN_RATE_WINDOW_MS - (now - bucket[0])) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      message: `Too many planning requests. Try again in ${retryAfter} seconds.`,
      code: 'BULK_AGENT_RATE_LIMITED',
      retryAfter,
    });
  }
  bucket.push(now);
  planRateBuckets.set(key, bucket);
  if (planRateBuckets.size > 10000) {
    for (const [bucketKey, timestamps] of planRateBuckets.entries()) {
      if (timestamps.every((timestamp) => now - timestamp >= PLAN_RATE_WINDOW_MS)) planRateBuckets.delete(bucketKey);
    }
  }
  return next();
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

export const getCampaignAccessQuery = (user) => {
  if (user?.role === 'owner') return {};
  const email = normalizeEmail(user?.email);
  const userId = normalizeId(user);
  const idClauses = userId
    ? [{ createdBy: user?._id }, { 'channels.assignedHandlerUserId': user?._id }]
    : [];
  const emailClauses = email
    ? [{ mainEmail: email }, { 'channels.assignedHandlerEmail': email }]
    : [];
  return {
    $or: [
      ...idClauses,
      ...emailClauses,
      ...((idClauses.length + emailClauses.length) === 0 ? [{ _id: null }] : []),
    ],
  };
};

const requireAccessibleCampaign = async ({ req, campaignId, isConnected }) => {
  if (!campaignId) {
    const error = new Error('Select a campaign before using the Bulk Builder assistant.');
    error.statusCode = 400;
    throw error;
  }
  if (!isConnected) return { _id: campaignId };
  if (!mongoose.isValidObjectId(campaignId)) {
    const error = new Error('Invalid campaign id.');
    error.statusCode = 400;
    throw error;
  }
  const campaign = await Campaign.findOne({
    _id: campaignId,
    ...getCampaignAccessQuery(req.user),
  }).select('_id name productName productSummary productDescription coreFunction useCases targetAudienceList showcaseLearning creativeBlueprints').lean();
  if (!campaign) {
    const error = new Error('Campaign not found or you do not have access to it.');
    error.statusCode = 404;
    throw error;
  }
  return campaign;
};

const getReadableScopeQuery = (campaignId) => ({
  $or: [{ campaignId }, { scope: 'global' }],
});

const getDescendantFolderIds = (rootFolder, folders) => {
  if (!rootFolder) return [];
  const ids = [normalizeId(rootFolder)];
  const queue = [...ids];
  while (queue.length > 0) {
    const parentId = queue.shift();
    folders.forEach((folder) => {
      const id = normalizeId(folder);
      if (normalizeId(folder.parentFolderId) === parentId && !ids.includes(id)) {
        ids.push(id);
        queue.push(id);
      }
    });
  }
  return ids;
};

const loadFolderMedia = async ({ folder, folders, campaignId, type, isConnected }) => {
  if (!folder) return [];
  const folderIds = getDescendantFolderIds(folder, folders);
  if (!isConnected) {
    const idSet = new Set(folderIds);
    return mockStore.media.filter((media) => idSet.has(normalizeId(media.folderId)) && media.type === type);
  }
  return Media.find({
    ...getReadableScopeQuery(campaignId),
    folderId: { $in: folderIds },
    type,
  }).sort({ uploadBatchCreatedAt: -1, uploadOrder: 1, createdAt: -1 }).lean();
};

const addRecursiveFolderCounts = async ({ folders, campaignId, isConnected }) => {
  const folderIds = folders.map((folder) => folder._id);
  let countRows;
  if (isConnected) {
    countRows = folderIds.length > 0
      ? await Media.aggregate([
          { $match: { ...getReadableScopeQuery(campaignId), folderId: { $in: folderIds } } },
          { $group: { _id: { folderId: '$folderId', type: '$type' }, count: { $sum: 1 } } },
        ])
      : [];
  } else {
    const counts = new Map();
    mockStore.media.forEach((media) => {
      const key = `${normalizeId(media.folderId)}:${media.type}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    countRows = [...counts.entries()].map(([key, count]) => {
      const separatorIndex = key.lastIndexOf(':');
      return {
        _id: { folderId: key.slice(0, separatorIndex), type: key.slice(separatorIndex + 1) },
        count,
      };
    });
  }
  const directCounts = new Map();
  countRows.forEach((row) => {
    const folderId = normalizeId(row._id.folderId);
    const counts = directCounts.get(folderId) || {};
    counts[row._id.type] = Number(row.count || 0);
    directCounts.set(folderId, counts);
  });
  const childrenByParent = new Map();
  folders.forEach((folder) => {
    const parentId = normalizeId(folder.parentFolderId);
    if (!parentId) return;
    const children = childrenByParent.get(parentId) || [];
    children.push(normalizeId(folder));
    childrenByParent.set(parentId, children);
  });
  const recursiveCounts = new Map();
  const getRecursiveCounts = (folderId, visiting = new Set()) => {
    if (recursiveCounts.has(folderId)) return recursiveCounts.get(folderId);
    if (visiting.has(folderId)) return {};
    const nextVisiting = new Set(visiting);
    nextVisiting.add(folderId);
    const result = { ...(directCounts.get(folderId) || {}) };
    (childrenByParent.get(folderId) || []).forEach((childId) => {
      const childCounts = getRecursiveCounts(childId, nextVisiting);
      Object.entries(childCounts).forEach(([type, count]) => {
        result[type] = (result[type] || 0) + count;
      });
    });
    recursiveCounts.set(folderId, result);
    return result;
  };
  return folders.map((folder) => {
    const typeCounts = getRecursiveCounts(normalizeId(folder));
    return {
      ...folder,
      typeCounts,
      itemCount: Object.values(typeCounts).reduce((sum, count) => sum + count, 0),
    };
  });
};

const prioritizePlannerFolders = (folders, mentionedFolderIds, limit = 150) => {
  const byId = new Map(folders.map((folder) => [normalizeId(folder), folder]));
  const selected = mentionedFolderIds.map((id) => byId.get(String(id))).filter(Boolean);
  const selectedIds = new Set(selected.map(normalizeId));
  return [
    ...selected,
    ...folders.filter((folder) => !selectedIds.has(normalizeId(folder))).slice(0, Math.max(0, limit - selected.length)),
  ];
};

const resolveStrictFolderMedia = async ({
  candidateIds,
  allowedFolderIds,
  folders,
  campaignId,
  type,
  isConnected,
}) => {
  const byId = new Map(folders.map((folder) => [normalizeId(folder), folder]));
  const allowed = allowedFolderIds?.length ? new Set(allowedFolderIds.map(String)) : null;
  const folderId = [...new Set(candidateIds.map(String).filter(Boolean))]
    .find((id) => (!allowed || allowed.has(id)) && byId.has(id));
  if (!folderId) return { folder: null, media: [] };
  const folder = byId.get(folderId);
  const media = await loadFolderMedia({ folder, folders, campaignId, type, isConnected });
  return { folder, media };
};

const getGeneratedUsageMedia = async ({ campaignId, candidateIds, isConnected }) => {
  if (candidateIds.length === 0) return [];
  if (!isConnected) {
    const candidates = new Set(candidateIds.map(String));
    return mockStore.media.filter((media) => (
      candidates.has(normalizeId(media.sourceUsage?.firstVideoId))
      || candidates.has(normalizeId(media.sourceUsage?.secondVideoId))
      || candidates.has(normalizeId(media.sourceUsage?.musicId))
    ));
  }
  return Media.find({
    campaignId,
    $or: [
      { 'sourceUsage.firstVideoId': { $in: candidateIds } },
      { 'sourceUsage.secondVideoId': { $in: candidateIds } },
      { 'sourceUsage.musicId': { $in: candidateIds } },
    ],
  }).select('sourceUsage createdAt').lean();
};

const collectReservedIds = (plans, excludedPlanIds = new Set()) => {
  const ids = new Set();
  plans.forEach((plan) => {
    if (excludedPlanIds.has(normalizeId(plan))) return;
    (plan.assignments || []).forEach((assignment) => {
      [assignment.video1, assignment.video2, assignment.audio].forEach((asset) => {
        const mediaId = normalizeId(asset?.mediaId);
        if (mediaId) ids.add(mediaId);
      });
    });
  });
  return ids;
};

const getReservationRecords = ({ assignments, planId, userId, campaignId, expiresAt }) => {
  const seen = new Set();
  const records = [];
  assignments.forEach((assignment) => {
    [
      ['video1', assignment.video1],
      ['video2', assignment.video2],
      ['audio', assignment.audio],
    ].forEach(([role, asset]) => {
      const sourceMediaId = normalizeId(asset?.mediaId);
      if (!sourceMediaId || seen.has(sourceMediaId)) return;
      seen.add(sourceMediaId);
      records.push({ userId, campaignId, planId, sourceMediaId, role, expiresAt });
    });
  });
  return records;
};

const isTransactionUnsupported = (error) => (
  error?.code === 20
  || error?.codeName === 'IllegalOperation'
  || /transaction numbers are only allowed|transactions are not supported/i.test(error?.message || '')
);

const withOptionalTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (!isTransactionUnsupported(error)) throw error;
    return work(null);
  } finally {
    await session.endSession();
  }
};

const queryOptions = (session) => (session ? { session } : {});

const serializePlan = (plan) => {
  if (!plan) return null;
  const value = typeof plan?.toObject === 'function' ? plan.toObject() : plan;
  return {
    id: normalizeId(value),
    campaignId: normalizeId(value.campaignId),
    message: value.message,
    assistantMessage: value.assistantMessage,
    operation: value.operation,
    status: value.status,
    tasks: value.tasks || [],
    assignments: value.assignments || [],
    targetRows: value.targetRows || [],
    mentionedFolders: value.mentionedFolders || [],
    isDualVideo: Boolean(value.isDualVideo),
    cooldownDays: Number(value.cooldownDays || 0),
    allowReuse: Boolean(value.allowReuse),
    availability: value.availability || {},
    summary: value.summary || {},
    warnings: value.warnings || [],
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
  };
};

const getOwnedPlan = async ({ planId, userId, isConnected, session = null }) => {
  if (!isConnected) {
    const plan = mockPlans.get(String(planId));
    return plan && normalizeId(plan.userId) === normalizeId(userId) ? plan : null;
  }
  if (!mongoose.isValidObjectId(planId)) return null;
  return BulkAgentPlan.findOne({ _id: planId, userId }).session(session);
};

const getPlanSourceIds = (plan) => [...new Set((plan.assignments || []).flatMap((assignment) => (
  [assignment.video1, assignment.video2, assignment.audio]
    .map((asset) => normalizeId(asset?.mediaId))
    .filter(Boolean)
)))];

const createPersistentPlan = async ({ planDocument, reservationRecords, supersededPlanIds, signal }) => {
  const planId = planDocument._id;
  const createWork = async (session) => {
    if (signal?.aborted) throw signal.reason || new Error('Planning request aborted.');
    const options = queryOptions(session);
    const previousPlans = !session && supersededPlanIds.length > 0
      ? await BulkAgentPlan.find({ _id: { $in: supersededPlanIds }, status: 'pending' }).lean()
      : [];
    const previousReservations = !session && supersededPlanIds.length > 0
      ? await BulkMediaReservation.find({ planId: { $in: supersededPlanIds } }).lean()
      : [];
    if (supersededPlanIds.length > 0) {
      await BulkAgentPlan.updateMany(
        { _id: { $in: supersededPlanIds }, status: 'pending' },
        { $set: { status: 'discarded', expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) } },
        options,
      );
      await BulkMediaReservation.deleteMany({ planId: { $in: supersededPlanIds } }, options);
    }
    let created;
    try {
      [created] = await BulkAgentPlan.create([planDocument], options);
      if (signal?.aborted) throw signal.reason || new Error('Planning request aborted.');
      if (reservationRecords.length > 0) {
        await BulkMediaReservation.insertMany(reservationRecords, { ordered: true, ...options });
      }
      if (signal?.aborted) throw signal.reason || new Error('Planning request aborted.');
      return created;
    } catch (error) {
      if (!session) {
        await BulkMediaReservation.deleteMany({ planId });
        await BulkAgentPlan.deleteOne({ _id: planId });
        const competingPending = await BulkAgentPlan.exists({
          userId: planDocument.userId,
          campaignId: planDocument.campaignId,
          status: 'pending',
          _id: { $ne: planId },
        });
        if (!competingPending && previousPlans.length > 0) {
          try {
            for (const previousPlan of previousPlans) {
              await BulkAgentPlan.updateOne(
                { _id: previousPlan._id, status: 'discarded' },
                { $set: { status: 'pending', expiresAt: previousPlan.expiresAt } },
              );
            }
            if (previousReservations.length > 0) {
              await BulkMediaReservation.bulkWrite(previousReservations.map((reservation) => ({
                replaceOne: {
                  filter: { _id: reservation._id },
                  replacement: reservation,
                  upsert: true,
                },
              })), { ordered: false });
            }
          } catch (restoreError) {
            await BulkAgentPlan.updateMany(
              { _id: { $in: supersededPlanIds }, status: 'pending' },
              { $set: { status: 'discarded', expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) } },
            );
            await BulkMediaReservation.deleteMany({ planId: { $in: supersededPlanIds } });
            console.error('Unable to restore superseded bulk plan after failed replacement:', restoreError);
          }
        }
      }
      throw error;
    }
  };
  return withOptionalTransaction(createWork);
};

export const buildTargetRows = ({ intent, currentBoard }) => {
  if (!['update', 'remove'].includes(intent.operation)) return [];
  const seen = new Set();
  return intent.targetFrameNumbers.flatMap((frameNumber) => {
    const index = Number(frameNumber) - 1;
    const row = currentBoard.rows[index];
    if (!row || seen.has(row.rowId)) return [];
    seen.add(row.rowId);
    return [{
      rowId: row.rowId,
      index: row.index,
      video1MediaId: row.video1MediaId,
      video2MediaId: row.video2MediaId,
      audioMediaId: row.audioMediaId,
      caption: row.caption,
      textOverlays: row.textOverlays,
    }];
  });
};

const toErrorPayload = (error, fallbackMessage) => {
  const payload = {
    message: error?.message || fallbackMessage,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.availability ? { availability: error.availability } : {}),
    ...(error?.retryAt ? { retryAt: error.retryAt } : {}),
    ...(error?.retryAfter ? { retryAfter: error.retryAfter } : {}),
  };
  return payload;
};

const validatePlanMediaAndReservations = async ({ plan, session = null }) => {
  const sourceIds = getPlanSourceIds(plan);
  if (sourceIds.length === 0) return;
  const now = new Date();
  const media = await Media.find({
    _id: { $in: sourceIds },
    ...getReadableScopeQuery(plan.campaignId),
  }).select('_id type sourceUsage').session(session).lean();
  const mediaById = new Map(media.map((item) => [normalizeId(item), item]));
  for (const assignment of plan.assignments || []) {
    for (const [role, asset] of [['video1', assignment.video1], ['video2', assignment.video2], ['audio', assignment.audio]]) {
      if (!asset?.mediaId) continue;
      const current = mediaById.get(normalizeId(asset.mediaId));
      const expectedType = role === 'audio' ? 'audio' : 'video';
      if (!current || current.type !== expectedType) {
        const error = new Error(`The source selected for ${role} is no longer available.`);
        error.statusCode = 409;
        error.code = 'PLAN_SOURCE_CHANGED';
        throw error;
      }
    }
  }
  const reservations = await BulkMediaReservation.find({
    planId: plan._id,
    campaignId: plan.campaignId,
    sourceMediaId: { $in: sourceIds },
    expiresAt: { $gt: now },
  }).select('sourceMediaId').session(session).lean();
  const reservationIds = new Set(reservations.map((reservation) => normalizeId(reservation.sourceMediaId)));
  const missingIds = sourceIds.filter((id) => !reservationIds.has(id));
  if (missingIds.length > 0) {
    const error = new Error('One or more source reservations expired or were released. Prepare the plan again.');
    error.statusCode = 409;
    error.code = 'PLAN_RESERVATION_LOST';
    throw error;
  }
  if (!plan.allowReuse && Number(plan.cooldownDays || 0) > 0) {
    const cutoff = new Date(Date.now() - (Number(plan.cooldownDays) * DAY_MS));
    const newlyUsed = await Media.exists({
      campaignId: plan.campaignId,
      createdAt: { $gte: cutoff },
      $or: [
        { 'sourceUsage.firstVideoId': { $in: sourceIds } },
        { 'sourceUsage.secondVideoId': { $in: sourceIds } },
        { 'sourceUsage.musicId': { $in: sourceIds } },
      ],
    }).session(session);
    if (newlyUsed) {
      const error = new Error('A selected source was used after this plan was prepared. Prepare it again.');
      error.statusCode = 409;
      error.code = 'PLAN_SOURCE_USED';
      throw error;
    }
  }
};

router.post('/plan', planRateLimit, async (req, res) => {
  const requestAbort = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) requestAbort.abort(new Error('Client disconnected during planning.'));
  };
  req.once('aborted', abortRequest);
  res.once('close', abortRequest);
  const {
    message,
    conversation = [],
    mentionedFolderIds = [],
    mentionedFolders = [],
    campaignId,
    isDualVideo = true,
    currentBoard: rawCurrentBoard,
    currentFrameCount = 0,
    allowReuse = false,
    cooldownDays,
  } = req.body || {};
  const trimmedMessage = String(message || '').trim();
  if (!trimmedMessage) {
    return res.status(400).json({ message: 'Describe what you want the Bulk Builder to create.' });
  }
  if (trimmedMessage.length > 5000) {
    return res.status(400).json({ message: 'The instruction is too long. Keep it under 5,000 characters.' });
  }
  if (allowReuse !== undefined && typeof allowReuse !== 'boolean') {
    return res.status(400).json({ message: 'allowReuse must be a boolean approval.' });
  }

  try {
    const isConnected = getDBStatus();
    const campaign = await requireAccessibleCampaign({ req, campaignId, isConnected });
    if (isConnected) {
      await healStalePlanTransitions({ userId: req.user._id, campaignId: campaign._id });
    }
    const folders = isConnected
      ? await Folder.find(getReadableScopeQuery(campaign._id)).sort({ name: 1 }).lean()
      : mockStore.folders;
    if (folders.length === 0) {
      return res.status(400).json({ message: 'This campaign has no Media Library folders.' });
    }
    const foldersForPlanner = await addRecursiveFolderCounts({
      folders,
      campaignId: campaign._id,
      isConnected,
    });
    const normalizedMentions = normalizeStructuredMentions({
      mentionedFolders,
      mentionedFolderIds,
      folders: foldersForPlanner,
      message: trimmedMessage,
    });
    const rawMentionIds = [...new Set([
      ...(Array.isArray(mentionedFolders) ? mentionedFolders.map((mention) => normalizeId(mention?.folderId)) : []),
      ...(Array.isArray(mentionedFolderIds) ? mentionedFolderIds.map(normalizeId) : []),
    ].filter(Boolean))];
    if (rawMentionIds.some((id) => !normalizedMentions.some((mention) => mention.folderId === id))) {
      return res.status(400).json({
        message: 'One or more attached folders are unavailable in this campaign.',
        code: 'INVALID_FOLDER_MENTION',
      });
    }
    const safeMentionIds = normalizedMentions.map((mention) => mention.folderId);
    if (safeMentionIds.length === 0) {
      const ambiguousName = findAmbiguousFolderNames(trimmedMessage, foldersForPlanner)[0];
      if (ambiguousName) {
        return res.status(400).json({
          message: `More than one folder is named “${ambiguousName}”. Select the intended folder with @.`,
          code: 'AMBIGUOUS_FOLDER_NAME',
        });
      }
    }
    const currentBoard = normalizeCurrentBoard(rawCurrentBoard, currentFrameCount, isDualVideo);
    const dualMode = typeof rawCurrentBoard?.isDualVideo === 'boolean'
      ? rawCurrentBoard.isDualVideo
      : Boolean(isDualVideo);
    const mentionRoles = mapStructuredMentionRoles({
      mentions: normalizedMentions,
      folders: foldersForPlanner,
      isDualVideo: dualMode,
      message: trimmedMessage,
    });
    const fallbackIntent = deriveFallbackIntent({
      message: trimmedMessage,
      folders: foldersForPlanner,
      mentionedFolders: normalizedMentions,
      mentionedFolderIds: safeMentionIds,
      isDualVideo: dualMode,
      currentBoard,
      cooldownDays,
    });
    const plannerFolders = prioritizePlannerFolders(foldersForPlanner, safeMentionIds);
    const deterministicTasks = fallbackIntent.tasks || [];
    const isFastPath = isDeterministicTaskPlan({
      tasks: deterministicTasks,
      message: trimmedMessage,
      fallbackIntent,
    });
    let intent;
    if (isFastPath) {
      intent = {
        ...fallbackIntent,
        status: 'ready',
        clarifyingQuestion: '',
        assistantMessage: 'I prepared this plan according to your instruction.',
        planner: 'deterministic-fast-path',
      };
    } else {
      intent = await planWithGemini({
        apiKey: process.env.GEMINI_API_KEY,
        message: trimmedMessage,
        conversation,
        folders: plannerFolders,
        mentionedFolders: normalizedMentions,
        mentionedFolderIds: safeMentionIds,
        isDualVideo: dualMode,
        currentBoard,
        cooldownDays,
        signal: requestAbort.signal,
      });
      if (requestAbort.signal.aborted) return;
    }

    if (intent.status === 'needs_clarification' && intent.clarifyingQuestion) {
      return res.status(200).json({
        plan: null,
        clarification: {
          question: intent.clarifyingQuestion,
          planner: intent.planner || 'gemini',
        },
      });
    }

    // Structured @ mentions are authoritative; Gemini may interpret prose but cannot redirect folders.
    if (safeMentionIds.length > 0) {
      intent.primaryFolderId = mentionRoles.primaryFolderId || fallbackIntent.primaryFolderId;
      intent.secondaryFolderId = dualMode
        ? (mentionRoles.secondaryFolderId || mentionRoles.primaryFolderId || fallbackIntent.secondaryFolderId)
        : '';
      intent.audioFolderId = mentionRoles.audioFolderId || '';
    }
    intent.allowReuse = allowReuse === true;
    intent.cooldownDays = Number.isFinite(Number(cooldownDays))
      ? Math.max(0, Math.min(3650, Number.parseInt(cooldownDays, 10)))
      : intent.cooldownDays;
    if (!dualMode && intent.changedFields.includes('video2')) {
      return res.status(400).json({ message: 'The board is in single-video mode, so it has no second-video slot.' });
    }

    let targetRows = buildTargetRows({ intent, currentBoard });
    if (intent.operation === 'clear') {
      targetRows = currentBoard.rows.map((row) => ({ ...row }));
    }
    if (['update', 'remove'].includes(intent.operation)) {
      if (currentBoard.rows.length === 0) {
        return res.status(400).json({ message: 'Send the current board rows before requesting a targeted edit.' });
      }
      if (targetRows.length !== intent.targetFrameNumbers.length || targetRows.length === 0) {
        return res.status(400).json({
          message: 'One or more requested frame numbers do not exist on the current board.',
          code: 'INVALID_TARGET_FRAME',
        });
      }
    }

    const isMediaOperation = !['remove', 'clear'].includes(intent.operation);
    if (isMediaOperation) {
      const captionTargetCount = intent.operation === 'update'
        ? targetRows.length
        : intent.frameCount;
      const captionResolution = intent.preserveExistingText
        && !intent.changedFields.includes('caption')
        ? { requested: false, captions: [], warning: '' }
        : resolveRequestedCaptions({
          message: trimmedMessage,
          captions: intent.captions,
          changedFields: intent.changedFields,
          targetCount: captionTargetCount,
        });
      if (captionResolution.requested && extractQuotedCaptionTexts(trimmedMessage).length === 0) {
        const showcaseEvidence = isConnected
          ? await Media.find({
              campaignId: campaign._id,
              type: 'video',
              aiStatus: 'completed',
            })
            .select('name aiAnalysis')
            .limit(10)
            .lean()
          : [];
        const creativeCaptions = await generateCaptionsWithGemini({
          apiKey: process.env.GEMINI_API_KEY,
          message: trimmedMessage,
          targetCount: captionTargetCount,
          campaignContext: {
            ...campaign,
            showcaseEvidence,
          },
          conversation,
          signal: requestAbort.signal,
        });
        if (requestAbort.signal.aborted) return;
        if (creativeCaptions.captions.length > 0) {
          captionResolution.captions = creativeCaptions.captions;
          captionResolution.usedFallback = false;
          captionResolution.warning = '';
          intent.captionWriter = creativeCaptions.model;
        } else if (creativeCaptions.warning) {
          captionResolution.warning = creativeCaptions.warning;
        }
      }
      if (captionResolution.requested) {
        intent.captions = captionResolution.captions;
        intent.captionWarning = captionResolution.warning;
      }
    }
    const changedFields = new Set(intent.operation === 'update' ? intent.changedFields : []);
    const needsPrimary = isMediaOperation && (intent.operation !== 'update' || changedFields.has('video1'));
    const needsSecondary = isMediaOperation && dualMode
      && (intent.operation !== 'update' || changedFields.has('video2'));
    const requestedMentionRoles = new Map((Array.isArray(mentionedFolders) ? mentionedFolders : [])
      .map((mention) => [normalizeId(mention?.folderId), String(mention?.role || 'unspecified').toLowerCase()]));
    const audioMentionContext = normalizedMentions.map((mention) => ({
      ...mention,
      requestedRole: requestedMentionRoles.get(mention.folderId) || mention.role,
    }));
    const audioSelection = resolveAudioFolderSelection({
      message: trimmedMessage,
      folders: foldersForPlanner,
      explicitFolderId: mentionRoles.audioFolderId,
      mentionedFolders: audioMentionContext,
    });
    const audioClearing = intent.operation === 'update'
      && intent.changedFields.includes('audio')
      && (audioSelection.audioIntent.clearing || audioSelection.audioIntent.disabled);
    if (!Array.isArray(intent.clearFields)) intent.clearFields = [];
    if (audioClearing && !intent.clearFields.includes('audio')) intent.clearFields.push('audio');
    const audioRequested = isMediaOperation
      && !audioSelection.audioIntent.disabled
      && !audioSelection.audioIntent.clearing
      && (
      changedFields.has('audio')
      || audioSelection.status === 'explicit'
      || audioSelection.audioIntent.requested
      );
    const restrictedIds = safeMentionIds.length > 0 ? safeMentionIds : null;
    const preferFallbackName = safeMentionIds.length === 0;

    if (audioRequested && audioSelection.status === 'ambiguous') {
      return res.status(400).json({
        message: 'More than one canonical “Trending songs” audio folder is available. Select the intended folder with @.',
        code: 'AMBIGUOUS_DEFAULT_AUDIO_FOLDER',
        candidates: audioSelection.candidates.map((folder) => ({
          folderId: normalizeId(folder),
          name: String(folder?.name || ''),
          scope: folder?.scope || 'campaign',
        })),
      });
    }
    if (isMediaOperation && audioSelection.status === 'invalid_explicit') {
      return res.status(400).json({
        message: `“${audioSelection.invalidFolder?.name || 'The selected folder'}” has no source audio. Select an audio folder with @.`,
        code: 'INVALID_AUDIO_FOLDER',
        folderId: normalizeId(audioSelection.invalidFolder),
      });
    }
    if (audioRequested && ['missing', 'not_audio_capable'].includes(audioSelection.status)) {
      const invalid = audioSelection.status === 'not_audio_capable';
      return res.status(400).json({
        message: invalid
          ? 'The canonical “Trending songs” folder is not audio-capable. Add audio there or select an audio folder with @.'
          : 'The canonical “Trending songs” audio folder is unavailable. Create it or select an audio folder with @.',
        code: invalid ? 'DEFAULT_AUDIO_FOLDER_INVALID' : 'DEFAULT_AUDIO_FOLDER_MISSING',
      });
    }

    const defaultPrimary = resolveDefaultPrimaryFolder(foldersForPlanner || folders);
    const defaultPrimaryId = normalizeId(defaultPrimary);
    const defaultSecondary = resolveDefaultSecondaryFolder(foldersForPlanner || folders, mentionRoles.primaryFolderId || intent.primaryFolderId || defaultPrimaryId);
    const defaultSecondaryId = normalizeId(defaultSecondary);

    const primaryResult = needsPrimary
      ? await resolveStrictFolderMedia({
          candidateIds: preferFallbackName
            ? [fallbackIntent.primaryFolderId, defaultPrimaryId]
            : [mentionRoles.primaryFolderId, intent.primaryFolderId, fallbackIntent.primaryFolderId, defaultPrimaryId],
          allowedFolderIds: restrictedIds,
          folders,
          campaignId: campaign._id,
          type: 'video',
          isConnected,
        })
      : { folder: null, media: [] };
    if (needsPrimary && !primaryResult.folder) {
      return res.status(400).json({ message: 'Attach the source folder to use for first videos.' });
    }
    intent.primaryFolderId = normalizeId(primaryResult.folder);

    const secondaryResult = needsSecondary
      ? await resolveStrictFolderMedia({
          candidateIds: preferFallbackName
            ? [fallbackIntent.secondaryFolderId, defaultSecondaryId, fallbackIntent.primaryFolderId, defaultPrimaryId]
            : [mentionRoles.secondaryFolderId, intent.secondaryFolderId, fallbackIntent.secondaryFolderId, defaultSecondaryId, mentionRoles.primaryFolderId, intent.primaryFolderId, fallbackIntent.primaryFolderId, defaultPrimaryId],
          allowedFolderIds: restrictedIds,
          folders,
          campaignId: campaign._id,
          type: 'video',
          isConnected,
        })
      : { folder: null, media: [] };
    if (needsSecondary && !secondaryResult.folder) {
      return res.status(400).json({ message: 'Attach the source folder to use for second videos.' });
    }
    intent.secondaryFolderId = normalizeId(secondaryResult.folder);

    const audioResult = audioRequested
      ? await resolveStrictFolderMedia({
          candidateIds: [audioSelection.folderId],
          // Audio has its own strict role scope. Video @mentions must never block
          // the canonical Trending songs fallback or become audio candidates.
          allowedFolderIds: [audioSelection.folderId],
          folders,
          campaignId: campaign._id,
          type: 'audio',
          isConnected,
        })
      : { folder: null, media: [] };
    if (audioRequested && !audioResult.folder) {
      return res.status(400).json({ message: 'Attach the audio folder to use for music.' });
    }
    intent.audioFolderId = normalizeId(audioResult.folder);

    let selection = {
      assignments: [],
      warnings: [],
      availability: {
        primary: { required: 0 },
        secondary: { required: 0 },
        audio: { required: 0 },
        allowReuse: intent.allowReuse,
        cooldownDays: intent.cooldownDays,
      },
    };
    const visualContext = await enrichCandidatesWithVisualContext({
      apiKey: process.env.GEMINI_API_KEY,
      candidates: [...primaryResult.media, ...secondaryResult.media],
      message: trimmedMessage,
      mentionedFolders: normalizedMentions,
      signal: requestAbort.signal,
    });
    if (requestAbort.signal.aborted) return;
    const visuallyEnrichedById = new Map(
      visualContext.candidates.map((media) => [normalizeId(media), media]),
    );
    primaryResult.media = primaryResult.media.map((media) => (
      visuallyEnrichedById.get(normalizeId(media)) || media
    ));
    secondaryResult.media = secondaryResult.media.map((media) => (
      visuallyEnrichedById.get(normalizeId(media)) || media
    ));
    if (isConnected && visualContext.analyzed.length > 0) {
      try {
        await Media.bulkWrite(visualContext.analyzed.map((analysis) => ({
          updateOne: {
            filter: { _id: analysis.mediaId, ...getReadableScopeQuery(campaign._id) },
            update: {
              $set: {
                visualSummary: analysis.visualSummary,
                visualTags: analysis.visualTags,
                visualAnalyzedAt: new Date(),
              },
            },
          },
        })), { ordered: false });
      } catch (cacheError) {
        console.warn('Unable to cache bulk-agent visual summaries:', cacheError?.message || cacheError);
      }
    }
    const allCandidates = [...primaryResult.media, ...secondaryResult.media, ...audioResult.media];
    const candidateIds = [...new Set(allCandidates.map(normalizeId).filter(Boolean))];
    const generatedMedia = await getGeneratedUsageMedia({
      campaignId: campaign._id,
      candidateIds,
      isConnected,
    });
    const supersededPlans = isConnected
      ? await BulkAgentPlan.find({
          userId: req.user._id,
          campaignId: campaign._id,
          status: 'pending',
        }).select('_id').lean()
      : [...mockPlans.values()].filter((plan) => (
          normalizeId(plan.userId) === normalizeId(req.user)
          && normalizeId(plan.campaignId) === normalizeId(campaign._id)
          && plan.status === 'pending'
        ));
    const supersededPlanIds = supersededPlans.map((plan) => plan._id);
    const excludedPlanIds = new Set(supersededPlanIds.map(normalizeId));
    let reservedIds = new Set();
    const reservationExpiries = new Map();
    if (isConnected) {
      const now = new Date();
      await BulkMediaReservation.deleteMany({ expiresAt: { $lte: now } });
      const query = {
        campaignId: campaign._id,
        expiresAt: { $gt: now },
        ...(supersededPlanIds.length > 0 ? { planId: { $nin: supersededPlanIds } } : {}),
      };
      const reservations = await BulkMediaReservation.find(query).select('sourceMediaId expiresAt').lean();
      reservations.forEach((reservation) => {
        const id = normalizeId(reservation.sourceMediaId);
        reservedIds.add(id);
        reservationExpiries.set(id, new Date(reservation.expiresAt));
      });
    } else {
      const activePlans = [...mockPlans.values()].filter((plan) => (
        normalizeId(plan.campaignId) === normalizeId(campaign._id)
        && ['pending', 'applied'].includes(plan.status)
        && new Date(plan.expiresAt) > new Date()
      ));
      reservedIds = collectReservedIds(activePlans, excludedPlanIds);
    }

    // Sources already staged on the current board are unavailable to a new plan,
    // even when they were added manually and have no reservation record.
    currentBoard.rows.forEach((row) => {
      [row.video1MediaId, row.video2MediaId, row.audioMediaId]
        .map(normalizeId)
        .filter(Boolean)
        .forEach((id) => reservedIds.add(id));
    });

    if (isMediaOperation) {
      selection = createAssignments({
        frameCount: intent.frameCount,
        primaryCandidates: primaryResult.media,
        secondaryCandidates: secondaryResult.media,
        audioCandidates: audioResult.media,
        isDualVideo: dualMode,
        cooldownDays: intent.cooldownDays,
        captions: intent.captions,
        usageIndex: buildUsageIndex(generatedMedia),
        reservedIds,
        reservationExpiries,
        allowReuse: intent.allowReuse,
        operation: intent.operation,
        changedFields: intent.changedFields,
        clearFields: intent.clearFields,
        targetRows,
        audioRequested,
        textOverlays: intent.textOverlays,
        selectionPrompt: trimmedMessage,
        preserveExistingText: intent.preserveExistingText,
        tasks: intent.tasks,
      });
    }
    if (requestAbort.signal.aborted) return;

    const expiresAt = new Date(Date.now() + PREVIEW_RESERVATION_MS);
    const foldersById = new Map(folders.map((folder) => [normalizeId(folder), folder]));
    const warnings = [
      ...(intent.plannerWarning ? [intent.plannerWarning] : []),
      ...(intent.captionWarning ? [intent.captionWarning] : []),
      ...selection.warnings,
    ];
    const summary = summarizeAssignments({
      assignments: selection.assignments,
      intent,
      foldersById,
      targetRows,
    });
    summary.visualCandidatesAnalyzed = visualContext.analyzed.length;
    const affectedCount = targetRows.length || selection.assignments.length;
    const assistantMessage = intent.assistantMessage || (
      intent.operation === 'clear'
        ? `I prepared a plan to clear ${targetRows.length} frames from the board.`
        : `I prepared a ${intent.operation} plan affecting ${affectedCount} frame${affectedCount === 1 ? '' : 's'}.`
    );
    const planId = isConnected ? new mongoose.Types.ObjectId() : `mock-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const planDocument = {
      _id: planId,
      userId: req.user._id,
      campaignId: campaign._id,
      message: trimmedMessage,
      assistantMessage,
      operation: intent.operation,
      status: 'pending',
      tasks: intent.tasks || [],
      assignments: selection.assignments,
      targetRows,
      mentionedFolders: normalizedMentions,
      boardSnapshot: currentBoard.rows,
      isDualVideo: dualMode,
      cooldownDays: intent.cooldownDays,
      allowReuse: intent.allowReuse,
      availability: selection.availability,
      summary,
      warnings,
      expiresAt,
    };
    let plan;
    if (isConnected) {
      const reservationRecords = getReservationRecords({
        assignments: selection.assignments,
        planId,
        userId: req.user._id,
        campaignId: campaign._id,
        expiresAt,
      });
      try {
        plan = await createPersistentPlan({
          planDocument,
          reservationRecords,
          supersededPlanIds,
          signal: requestAbort.signal,
        });
      } catch (error) {
        if (error?.code === 11000) {
          const conflict = new Error('Another plan reserved one of these sources. Retry with the latest availability.');
          conflict.statusCode = 409;
          conflict.code = 'MEDIA_RESERVATION_CONFLICT';
          throw conflict;
        }
        throw error;
      }
    } else {
      supersededPlans.forEach((oldPlan) => {
        oldPlan.status = 'discarded';
        oldPlan.expiresAt = new Date(Date.now() + DISCARDED_PLAN_TTL_MS);
      });
      plan = planDocument;
      mockPlans.set(String(planId), plan);
    }
    return res.status(201).json({ plan: serializePlan(plan) });
  } catch (error) {
    if (requestAbort.signal.aborted || res.headersSent) return undefined;
    console.error('Bulk agent planning error:', error);
    const status = error?.statusCode || (error?.name === 'CastError' ? 400 : 500);
    if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    return res.status(status).json(toErrorPayload(error, 'Unable to prepare the bulk plan.'));
  } finally {
    req.removeListener('aborted', abortRequest);
    res.removeListener('close', abortRequest);
  }
});

export const assertBoardTargetsUnchanged = ({ plan, rawCurrentBoard }) => {
  if (!rawCurrentBoard) {
    const error = new Error('The current board is required to apply this plan safely.');
    error.statusCode = 400;
    error.code = 'CURRENT_BOARD_REQUIRED';
    throw error;
  }
  const currentBoard = normalizeCurrentBoard(rawCurrentBoard, 0, plan.isDualVideo);
  if (typeof rawCurrentBoard.isDualVideo === 'boolean'
      && rawCurrentBoard.isDualVideo !== Boolean(plan.isDualVideo)) {
    const error = new Error('The board mode changed after this plan was prepared. Prepare the plan again.');
    error.statusCode = 409;
    error.code = 'BOARD_MODE_CHANGED';
    throw error;
  }
  if (plan.operation === 'append') {
    const plannedSourceIds = new Set(getPlanSourceIds(plan));
    const conflict = currentBoard.rows.some((row) => (
      [row.video1MediaId, row.video2MediaId, row.audioMediaId]
        .map(normalizeId)
        .some((id) => id && plannedSourceIds.has(id))
    ));
    if (conflict) {
      const error = new Error('A planned source was added to the board after this plan was prepared. Prepare it again.');
      error.statusCode = 409;
      error.code = 'BOARD_SOURCE_CONFLICT';
      throw error;
    }
    return;
  }
  if (['replace', 'clear'].includes(plan.operation)) {
    const snapshot = Array.isArray(plan.boardSnapshot) ? plan.boardSnapshot : [];
    const fields = ['rowId', 'index', 'video1MediaId', 'video2MediaId', 'audioMediaId', 'caption', 'textOverlays'];
    const changed = snapshot.length !== currentBoard.rows.length
      || snapshot.some((row, index) => fields.some((field) => (
        JSON.stringify(row?.[field] ?? '') !== JSON.stringify(currentBoard.rows[index]?.[field] ?? '')
      )));
    if (changed) {
      const error = new Error('The board changed after this plan was prepared. Prepare the plan again.');
      error.statusCode = 409;
      error.code = 'BOARD_CHANGED';
      throw error;
    }
    return;
  }
  const byId = new Map(currentBoard.rows.map((row) => [row.rowId, row]));
  for (const target of plan.targetRows || []) {
    const current = byId.get(target.rowId);
    if (!current) {
      const error = new Error('The board changed after this plan was prepared. Prepare the edit again.');
      error.statusCode = 409;
      error.code = 'BOARD_CHANGED';
      throw error;
    }
    const fields = ['video1MediaId', 'video2MediaId', 'audioMediaId', 'caption', 'textOverlays'];
    if (fields.some((field) => JSON.stringify(current[field] || '') !== JSON.stringify(target[field] || ''))) {
      const error = new Error('A targeted frame changed after this plan was prepared. Prepare the edit again.');
      error.statusCode = 409;
      error.code = 'BOARD_CHANGED';
      throw error;
    }
  }
};

const applyPersistentPlan = async ({ planId, userId, rawCurrentBoard }) => {
  const work = async (session) => {
    const now = new Date();
    let nextExpiry;
    const locked = await BulkAgentPlan.findOneAndUpdate(
      {
        _id: planId,
        userId,
        status: 'pending',
        expiresAt: { $gt: now },
      },
      { $set: { status: 'applying', transitionStartedAt: now, transitionFromStatus: 'pending' } },
      { new: true, ...queryOptions(session) },
    );
    if (!locked) {
      const current = await getOwnedPlan({ planId, userId, isConnected: true, session });
      if (!current) {
        const error = new Error('Bulk plan not found.');
        error.statusCode = 404;
        throw error;
      }
      if (current.status === 'applied') {
        assertBoardTargetsUnchanged({ plan: current, rawCurrentBoard });
        return current;
      }
      if (current.status === 'pending' && new Date(current.expiresAt) <= now) {
        const error = new Error('This plan expired. Ask the assistant to prepare it again.');
        error.statusCode = 409;
        error.code = 'PLAN_EXPIRED';
        throw error;
      }
      const error = new Error(`This plan is currently ${current.status}.`);
      error.statusCode = 409;
      error.code = 'PLAN_STATUS_CONFLICT';
      throw error;
    }
    let previousReservations = [];
    try {
      nextExpiry = getAppliedReservationExpiry(locked);
      assertBoardTargetsUnchanged({ plan: locked, rawCurrentBoard });
      await validatePlanMediaAndReservations({ plan: locked, session });
      const sourceIds = getPlanSourceIds(locked);
      if (sourceIds.length > 0) {
        previousReservations = await BulkMediaReservation.find({
          planId: locked._id,
          sourceMediaId: { $in: sourceIds },
        }).select('_id expiresAt').session(session).lean();
        const reservationUpdate = await BulkMediaReservation.updateMany(
          {
            planId: locked._id,
            campaignId: locked.campaignId,
            sourceMediaId: { $in: sourceIds },
            expiresAt: { $gt: now },
          },
          { $set: { expiresAt: nextExpiry } },
          queryOptions(session),
        );
        if (Number(reservationUpdate.matchedCount) !== sourceIds.length) {
          const error = new Error('Unable to extend every source reservation. Prepare the plan again.');
          error.statusCode = 409;
          error.code = 'PLAN_RESERVATION_LOST';
          throw error;
        }
      }
      const applied = await BulkAgentPlan.findOneAndUpdate(
        { _id: locked._id, userId, status: 'applying' },
        {
          $set: { status: 'applied', expiresAt: nextExpiry },
          $unset: { transitionStartedAt: '', transitionFromStatus: '' },
        },
        { new: true, ...queryOptions(session) },
      );
      if (!applied) {
        const error = new Error('The plan changed while it was being applied.');
        error.statusCode = 409;
        error.code = 'PLAN_STATUS_CONFLICT';
        throw error;
      }
      return applied;
    } catch (error) {
      if (!session) {
        if (previousReservations.length > 0 && error?.code !== 'PLAN_RESERVATION_LOST') {
          await BulkMediaReservation.bulkWrite(previousReservations.map((reservation) => ({
            updateOne: {
              filter: { _id: reservation._id, planId: locked._id },
              update: { $set: { expiresAt: reservation.expiresAt } },
            },
          })));
        }
        const reservationLost = error?.code === 'PLAN_RESERVATION_LOST';
        try {
          await BulkAgentPlan.updateOne(
            { _id: locked._id, userId, status: 'applying' },
            {
              $set: {
                status: reservationLost ? 'discarded' : 'pending',
                ...(reservationLost ? { expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) } : {}),
              },
              $unset: { transitionStartedAt: '', transitionFromStatus: '' },
            },
          );
          if (reservationLost) await BulkMediaReservation.deleteMany({ planId: locked._id });
        } catch (resetError) {
          if (resetError?.code === 11000) {
            await BulkAgentPlan.updateOne(
              { _id: locked._id, userId, status: 'applying' },
              {
                $set: { status: 'discarded', expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) },
                $unset: { transitionStartedAt: '', transitionFromStatus: '' },
              },
            );
            await BulkMediaReservation.deleteMany({ planId: locked._id });
          } else {
            throw resetError;
          }
        }
      }
      throw error;
    }
  };
  return withOptionalTransaction(work);
};

router.post('/plans/:planId/apply', async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (isConnected) await healStalePlanTransitions({ userId: req.user._id });
    const existing = await getOwnedPlan({
      planId: req.params.planId,
      userId: req.user._id,
      isConnected,
    });
    if (!existing) return res.status(404).json({ message: 'Bulk plan not found.' });
    await requireAccessibleCampaign({ req, campaignId: existing.campaignId, isConnected });
    if (!isConnected) {
      if (existing.status === 'applied') {
        assertBoardTargetsUnchanged({ plan: existing, rawCurrentBoard: req.body?.currentBoard });
        return res.status(200).json({ plan: serializePlan(existing) });
      }
      if (existing.status !== 'pending') {
        return res.status(409).json({ message: `This plan is already ${existing.status}.` });
      }
      if (new Date(existing.expiresAt) <= new Date()) {
        return res.status(409).json({ message: 'This plan expired. Ask the assistant to prepare it again.' });
      }
      assertBoardTargetsUnchanged({ plan: existing, rawCurrentBoard: req.body?.currentBoard });
      existing.status = 'applied';
      existing.expiresAt = getAppliedReservationExpiry(existing);
      return res.status(200).json({ plan: serializePlan(existing) });
    }
    const applied = await applyPersistentPlan({
      planId: existing._id,
      userId: req.user._id,
      rawCurrentBoard: req.body?.currentBoard,
    });
    return res.status(200).json({ plan: serializePlan(applied) });
  } catch (error) {
    const status = error?.statusCode || 500;
    return res.status(status).json(toErrorPayload(error, 'Unable to apply the bulk plan.'));
  }
});

const releasePersistentPlan = async ({ planId, userId, sourceMediaIds, discard = false }) => {
  const requestedIds = [...new Set((Array.isArray(sourceMediaIds) ? sourceMediaIds : [])
    .map(normalizeId)
    .filter(Boolean))];
  const work = async (session) => {
    const existing = await getOwnedPlan({ planId, userId, isConnected: true, session });
    if (!existing) {
      const error = new Error('Bulk plan not found.');
      error.statusCode = 404;
      throw error;
    }
    if (['discarded', 'released'].includes(existing.status)) {
      await BulkMediaReservation.deleteMany({ planId: existing._id }, queryOptions(session));
      const terminalIds = requestedIds.length > 0 ? requestedIds : getPlanSourceIds(existing);
      return {
        plan: existing,
        releasedCount: 0,
        remainingCount: 0,
        releasedSourceMediaIds: terminalIds,
        alreadyReleasedSourceMediaIds: terminalIds,
        alreadyReleased: true,
        planExpired: new Date(existing.expiresAt) <= new Date(),
      };
    }
    if (['applying', 'discarding', 'releasing'].includes(existing.status)) {
      const error = new Error(`This plan is currently ${existing.status}.`);
      error.statusCode = 409;
      error.code = 'PLAN_STATUS_CONFLICT';
      throw error;
    }
    const allSourceIds = getPlanSourceIds(existing);
    const releaseAll = discard || requestedIds.length === 0;
    if (!releaseAll) {
      const validIds = new Set(allSourceIds);
      if (requestedIds.some((id) => !validIds.has(id))) {
        const error = new Error('The release request contains media that does not belong to this plan.');
        error.statusCode = 400;
        error.code = 'INVALID_RELEASE_SOURCE';
        throw error;
      }
      if (existing.status === 'pending') {
        const error = new Error('A pending plan must be discarded as a whole.');
        error.statusCode = 409;
        error.code = 'PARTIAL_PENDING_RELEASE';
        throw error;
      }
    }
    const lockStatus = discard ? 'discarding' : 'releasing';
    const releaseTargetIds = releaseAll ? allSourceIds : requestedIds;
    const transitionStartedAt = new Date();
    const locked = await BulkAgentPlan.findOneAndUpdate(
      { _id: existing._id, userId, status: existing.status },
      {
        $set: {
          status: lockStatus,
          transitionStartedAt,
          transitionFromStatus: existing.status,
          releaseIntent: { sourceMediaIds: releaseTargetIds, releaseAll, discard },
        },
      },
      { new: true, runValidators: true, ...queryOptions(session) },
    );
    if (!locked) {
      const error = new Error('The plan changed while media was being released.');
      error.statusCode = 409;
      error.code = 'PLAN_STATUS_CONFLICT';
      throw error;
    }
    const deleteQuery = {
      planId: locked._id,
      ...(releaseAll ? {} : { sourceMediaId: { $in: requestedIds } }),
    };
    let previousReservations = [];
    try {
      previousReservations = await BulkMediaReservation.find(deleteQuery).session(session).lean();
      const previouslyReservedIds = new Set(previousReservations.map((item) => normalizeId(item.sourceMediaId)));
      const deletion = await BulkMediaReservation.deleteMany(deleteQuery, queryOptions(session));
      const remainingReservations = await BulkMediaReservation.find({ planId: locked._id })
        .select('sourceMediaId').session(session).lean();
      const remainingIds = new Set(remainingReservations.map((item) => normalizeId(item.sourceMediaId)));
      const releasedSourceMediaIds = releaseTargetIds.filter((id) => !remainingIds.has(id));
      const alreadyReleasedSourceMediaIds = releaseTargetIds.filter((id) => !previouslyReservedIds.has(id));
      const remainingCount = remainingReservations.length;
      const finalStatus = discard || remainingCount === 0 ? (discard ? 'discarded' : 'released') : 'applied';
      const finalPlan = await BulkAgentPlan.findOneAndUpdate(
        { _id: locked._id, userId, status: lockStatus },
        {
          $set: {
            status: finalStatus,
            ...(finalStatus === 'applied' ? {} : { expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) }),
          },
          $unset: { transitionStartedAt: '', transitionFromStatus: '', releaseIntent: '' },
        },
        { new: true, runValidators: true, ...queryOptions(session) },
      );
      if (!finalPlan) {
        const error = new Error('Unable to finish releasing this plan.');
        error.statusCode = 409;
        error.code = 'PLAN_STATUS_CONFLICT';
        throw error;
      }
      return {
        plan: finalPlan,
        releasedCount: Number(deletion.deletedCount || 0),
        remainingCount,
        releasedSourceMediaIds,
        alreadyReleasedSourceMediaIds,
        alreadyReleased: deletion.deletedCount === 0,
        planExpired: new Date(existing.expiresAt) <= new Date(),
      };
    } catch (error) {
      if (!session) {
        let restored = true;
        if (previousReservations.length > 0) {
          try {
            await BulkMediaReservation.bulkWrite(previousReservations.map((reservation) => ({
              replaceOne: {
                filter: { _id: reservation._id },
                replacement: reservation,
                upsert: true,
              },
            })), { ordered: false });
          } catch {
            const restoredCount = await BulkMediaReservation.countDocuments({
              _id: { $in: previousReservations.map((reservation) => reservation._id) },
              planId: locked._id,
            });
            restored = restoredCount === previousReservations.length;
          }
        }
        if (restored) {
          await BulkAgentPlan.updateOne(
            { _id: locked._id, userId, status: lockStatus },
            {
              $set: { status: existing.status },
              $unset: { transitionStartedAt: '', transitionFromStatus: '', releaseIntent: '' },
            },
          );
        }
      }
      throw error;
    }
  };
  return withOptionalTransaction(work);
};

const healStalePlanTransitions = async ({ userId, campaignId = null }) => {
  const staleBefore = new Date(Date.now() - TRANSITION_LEASE_MS);
  const plans = await BulkAgentPlan.find({
    userId,
    ...(campaignId ? { campaignId } : {}),
    status: { $in: ['applying', 'releasing', 'discarding'] },
    $or: [
      { transitionStartedAt: { $lte: staleBefore } },
      { transitionStartedAt: null },
      { transitionStartedAt: { $exists: false } },
    ],
  }).limit(20);
  for (const plan of plans) {
    try {
      if (plan.status === 'applying') {
        const competingPending = await BulkAgentPlan.exists({
          _id: { $ne: plan._id },
          userId: plan.userId,
          campaignId: plan.campaignId,
          status: 'pending',
        });
        const discardPlan = new Date(plan.expiresAt) <= new Date() || Boolean(competingPending);
        if (discardPlan) {
          await BulkMediaReservation.deleteMany({ planId: plan._id });
        } else {
          await BulkMediaReservation.updateMany(
            { planId: plan._id },
            { $set: { expiresAt: plan.expiresAt } },
          );
        }
        await BulkAgentPlan.updateOne(
          { _id: plan._id, status: 'applying', transitionStartedAt: plan.transitionStartedAt },
          {
            $set: {
              status: discardPlan ? 'discarded' : 'pending',
              ...(discardPlan ? { expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) } : {}),
            },
            $unset: { transitionStartedAt: '', transitionFromStatus: '' },
          },
        );
        continue;
      }
      const intent = plan.releaseIntent || {};
      const releaseIds = Array.isArray(intent.sourceMediaIds) ? intent.sourceMediaIds.filter(Boolean) : [];
      await BulkMediaReservation.deleteMany({
        planId: plan._id,
        ...(intent.releaseAll || releaseIds.length === 0 ? {} : { sourceMediaId: { $in: releaseIds } }),
      });
      const remainingCount = await BulkMediaReservation.countDocuments({ planId: plan._id });
      const discard = plan.status === 'discarding' || intent.discard;
      const finalStatus = discard
        ? 'discarded'
        : (remainingCount === 0 ? 'released' : (plan.transitionFromStatus || 'applied'));
      await BulkAgentPlan.updateOne(
        { _id: plan._id, status: plan.status, transitionStartedAt: plan.transitionStartedAt },
        {
          $set: {
            status: finalStatus,
            ...(['discarded', 'released'].includes(finalStatus)
              ? { expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) }
              : {}),
          },
          $unset: { transitionStartedAt: '', transitionFromStatus: '', releaseIntent: '' },
        },
      );
    } catch (error) {
      console.error(`Unable to heal stale bulk plan transition ${normalizeId(plan)}:`, error);
    }
  }
};

const getPendingPlan = async (req, res) => {
  try {
    const { campaignId } = req.query;
    const isConnected = getDBStatus();
    const campaign = await requireAccessibleCampaign({ req, campaignId, isConnected });
    if (isConnected) {
      await healStalePlanTransitions({ userId: req.user._id, campaignId: campaign._id });
    }
    const now = new Date();
    let plan = null;
    if (isConnected) {
      const expiredPlans = await BulkAgentPlan.find({
        userId: req.user._id,
        campaignId: campaign._id,
        status: 'pending',
        expiresAt: { $lte: now },
      }).select('_id').lean();
      const expiredIds = expiredPlans.map((item) => item._id);
      if (expiredIds.length > 0) {
        await BulkAgentPlan.updateMany(
          { _id: { $in: expiredIds }, status: 'pending' },
          { $set: { status: 'discarded', expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) } },
        );
        await BulkMediaReservation.deleteMany({ planId: { $in: expiredIds } });
      }
      plan = await BulkAgentPlan.findOne({
        userId: req.user._id,
        campaignId: campaign._id,
        status: 'pending',
        expiresAt: { $gt: now },
      }).sort({ createdAt: -1 });
      if (plan) {
        const expectedCount = getPlanSourceIds(plan).length;
        const reservationCount = await BulkMediaReservation.countDocuments({
          planId: plan._id,
          expiresAt: { $gt: now },
        });
        if (reservationCount !== expectedCount) {
          await BulkAgentPlan.updateOne(
            { _id: plan._id, status: 'pending' },
            { $set: { status: 'discarded', expiresAt: new Date(Date.now() + DISCARDED_PLAN_TTL_MS) } },
          );
          await BulkMediaReservation.deleteMany({ planId: plan._id });
          plan = null;
        }
      }
    } else {
      plan = [...mockPlans.values()]
        .filter((item) => (
          normalizeId(item.userId) === normalizeId(req.user)
          && normalizeId(item.campaignId) === normalizeId(campaign._id)
          && item.status === 'pending'
          && new Date(item.expiresAt) > now
        ))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
    }
    return res.status(200).json({ plan: serializePlan(plan) });
  } catch (error) {
    return res.status(error?.statusCode || 500).json(toErrorPayload(error, 'Unable to recover the pending plan.'));
  }
};

router.get('/plans/pending', getPendingPlan);
router.get('/plans/current', getPendingPlan);

router.get('/plans/:planId', async (req, res) => {
  try {
    const isConnected = getDBStatus();
    if (isConnected) await healStalePlanTransitions({ userId: req.user._id });
    const plan = await getOwnedPlan({
      planId: req.params.planId,
      userId: req.user._id,
      isConnected,
    });
    if (!plan) return res.status(404).json({ message: 'Bulk plan not found.' });
    await requireAccessibleCampaign({ req, campaignId: plan.campaignId, isConnected });
    return res.status(200).json({ plan: serializePlan(plan) });
  } catch (error) {
    return res.status(error?.statusCode || 500).json(toErrorPayload(error, 'Unable to recover the bulk plan.'));
  }
});

const releaseOwnedPlan = async ({ req, planId, sourceMediaIds, discard = false }) => {
  const isConnected = getDBStatus();
  if (isConnected) await healStalePlanTransitions({ userId: req.user._id });
  const existing = await getOwnedPlan({ planId, userId: req.user._id, isConnected });
  if (!existing) {
    const error = new Error('Bulk plan not found.');
    error.statusCode = 404;
    throw error;
  }
  await requireAccessibleCampaign({ req, campaignId: existing.campaignId, isConnected });
  if (isConnected) {
    return releasePersistentPlan({
      planId: existing._id,
      userId: req.user._id,
      sourceMediaIds,
      discard,
    });
  }
  if (['discarded', 'released'].includes(existing.status)) {
    const terminalIds = Array.isArray(sourceMediaIds) && sourceMediaIds.length > 0
      ? sourceMediaIds.map(normalizeId).filter(Boolean)
      : getPlanSourceIds(existing);
    return {
      plan: existing,
      releasedCount: 0,
      remainingCount: 0,
      releasedSourceMediaIds: terminalIds,
      alreadyReleasedSourceMediaIds: terminalIds,
      alreadyReleased: true,
      planExpired: new Date(existing.expiresAt) <= new Date(),
    };
  }
  if (!['pending', 'applied'].includes(existing.status)) {
    const error = new Error(`This plan is currently ${existing.status}.`);
    error.statusCode = 409;
    throw error;
  }
  const allIds = getPlanSourceIds(existing);
  const requestedIds = [...new Set((Array.isArray(sourceMediaIds) ? sourceMediaIds : []).map(normalizeId).filter(Boolean))];
  if (requestedIds.some((id) => !allIds.includes(id))) {
    const error = new Error('The release request contains media that does not belong to this plan.');
    error.statusCode = 400;
    throw error;
  }
  const releasedCount = discard || requestedIds.length === 0 ? allIds.length : requestedIds.length;
  existing.status = discard ? 'discarded' : (releasedCount >= allIds.length ? 'released' : 'applied');
  if (existing.status !== 'applied') existing.expiresAt = new Date(Date.now() + DISCARDED_PLAN_TTL_MS);
  return {
    plan: existing,
    releasedCount,
    remainingCount: Math.max(0, allIds.length - releasedCount),
    releasedSourceMediaIds: requestedIds.length > 0 ? requestedIds : allIds,
    alreadyReleasedSourceMediaIds: [],
    alreadyReleased: false,
    planExpired: new Date(existing.expiresAt) <= new Date(),
  };
};

router.post('/plans/:planId/release', async (req, res) => {
  try {
    const result = await releaseOwnedPlan({
      req,
      planId: req.params.planId,
      sourceMediaIds: req.body?.sourceMediaIds,
    });
    return res.status(200).json({
      plan: serializePlan(result.plan),
      releasedCount: result.releasedCount,
      remainingCount: result.remainingCount,
      releasedSourceMediaIds: result.releasedSourceMediaIds || [],
      alreadyReleasedSourceMediaIds: result.alreadyReleasedSourceMediaIds || [],
      alreadyReleased: Boolean(result.alreadyReleased),
      planExpired: Boolean(result.planExpired),
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json(toErrorPayload(error, 'Unable to release plan media.'));
  }
});

router.post('/plans/release', async (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (entries.length === 0 || entries.length > 100) {
    return res.status(400).json({ message: 'Provide between 1 and 100 plan release entries.' });
  }
  const results = [];
  for (const entry of entries) {
    const planId = String(entry?.planId || '');
    if (!planId) {
      results.push({
        planId: '',
        ok: false,
        error: { message: 'Every release entry requires a planId.', status: 400 },
      });
      continue;
    }
    try {
      const result = await releaseOwnedPlan({
        req,
        planId,
        sourceMediaIds: entry.sourceMediaIds,
      });
      results.push({
        planId,
        ok: true,
        releasedCount: result.releasedCount,
        remainingCount: result.remainingCount,
        releasedSourceMediaIds: result.releasedSourceMediaIds || [],
        alreadyReleasedSourceMediaIds: result.alreadyReleasedSourceMediaIds || [],
        alreadyReleased: Boolean(result.alreadyReleased),
        planExpired: Boolean(result.planExpired),
        terminal: ['discarded', 'released'].includes(result.plan?.status) || result.remainingCount === 0,
        plan: serializePlan(result.plan),
      });
    } catch (error) {
      const status = error?.statusCode || 500;
      const terminal = [404, 410].includes(status);
      results.push({
        planId,
        ok: false,
        terminal,
        releasedSourceMediaIds: terminal
          ? [...new Set((Array.isArray(entry.sourceMediaIds) ? entry.sourceMediaIds : []).map(normalizeId).filter(Boolean))]
          : [],
        error: {
          ...toErrorPayload(error, 'Unable to release plan media.'),
          status,
        },
      });
    }
  }
  return res.status(200).json({ results });
});

router.post('/plans/:planId/discard', async (req, res) => {
  try {
    const result = await releaseOwnedPlan({
      req,
      planId: req.params.planId,
      discard: true,
    });
    return res.status(200).json({
      plan: serializePlan(result.plan),
      releasedCount: result.releasedCount,
      remainingCount: result.remainingCount,
      releasedSourceMediaIds: result.releasedSourceMediaIds || [],
      alreadyReleasedSourceMediaIds: result.alreadyReleasedSourceMediaIds || [],
      alreadyReleased: Boolean(result.alreadyReleased),
      planExpired: Boolean(result.planExpired),
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json(toErrorPayload(error, 'Unable to discard the bulk plan.'));
  }
});

export default router;
