import express from 'express';
import mongoose from 'mongoose';
import { getDBStatus } from '../config/db.js';
import { protect, resolveHandlerPreview } from '../middleware/auth.js';
import SocialAccount from '../models/SocialAccount.js';
import CampaignChannel from '../models/CampaignChannel.js';
import AutomationRule from '../models/AutomationRule.js';
import AutomationEvent from '../models/AutomationEvent.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import SocialComment from '../models/SocialComment.js';
import { visibleEngagementFilter } from '../utils/engagementRetention.js';
import { recordOwnReply, syncRecentComments } from '../services/commentFeedService.js';
import {
  getReplyWindowClosesAt,
  isReplyWindowOpen,
  sendConversationMessage,
  syncConversations,
} from '../services/inboxService.js';
import {
  AUTOMATION_PLATFORMS,
  fetchMediaComments,
  fetchRecentMedia,
  hasAutomationScopes,
  hasCurrentWebhookSubscription,
  isValidObjectId,
  replyToComment,
  sendPrivateReply,
  subscribeAccountToWebhooks,
  supportsDm,
} from '../services/socialProviders/index.js';

const router = express.Router();

/**
 * Meta / YouTube rejected the call. Answered with 424 rather than 502: proxies like nginx and
 * Cloudflare replace 502 bodies with their own error page, which hides the provider's reason.
 */
const sendProviderError = (res, req, error) => {
  console.error(`[Automations] ${req.method} ${req.path} failed:`, error.message, error.data?.error || '');
  res.status(error.statusCode && error.statusCode < 500 ? error.statusCode : 424).json({ message: error.message });
};

const MAX_KEYWORDS = 30;
const MAX_REPLIES = 10;
const MAX_MEDIA_IDS = 100;
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

router.use(protect, resolveHandlerPreview, (req, res, next) => {
  if (!getDBStatus()) {
    return res.status(503).json({ message: 'Database disconnected.' });
  }
  return next();
});

// Instagram accounts and Facebook Pages the user connected themselves or was assigned as handler
const getManageableAccountQuery = async (req) => {
  const handlerEmail = (req.user.email || '').trim().toLowerCase();
  const assignedChannels = await CampaignChannel.find({
    $or: [
      { assignedHandlerUserId: req.user._id },
      ...(handlerEmail ? [{ assignedHandlerEmail: handlerEmail }] : []),
    ],
  }).select('socialAccountId').lean();
  const assignedIds = assignedChannels.map((channel) => channel.socialAccountId).filter(Boolean);

  const accessible = {
    platform: { $in: AUTOMATION_PLATFORMS },
    isConnected: true,
    $or: [
      { userId: req.user._id },
      { _id: { $in: assignedIds } },
    ],
  };
  return accessible;
};

const findManageableAccount = async (req, accountId) => {
  if (!mongoose.isValidObjectId(accountId)) return null;
  return SocialAccount.findOne({ _id: accountId, ...(await getManageableAccountQuery(req)) });
};

const getManageableAccountIds = async (req) => (
  (await SocialAccount.find(await getManageableAccountQuery(req)).select('_id').lean()).map((account) => account._id)
);

const cleanStringList = (value, { max, maxLength }) => (
  Array.isArray(value) ? value : []
)
  .map((item) => String(item ?? '').trim().slice(0, maxLength))
  .filter(Boolean)
  .filter((item, index, list) => list.indexOf(item) === index)
  .slice(0, max);

// YouTube has no DMs, so rules there can only reply publicly
const buildRulePayload = (body = {}, platform = 'instagram') => {
  const canDm = supportsDm(platform);
  const payload = {
    name: String(body.name || '').trim().slice(0, 120),
    enabled: body.enabled !== false,
    mediaScope: body.mediaScope === 'specific' ? 'specific' : 'all',
    mediaIds: cleanStringList(body.mediaIds, { max: MAX_MEDIA_IDS, maxLength: 64 }),
    triggerType: body.triggerType === 'any' ? 'any' : 'keywords',
    keywords: cleanStringList(body.keywords, { max: MAX_KEYWORDS, maxLength: 60 }),
    commentReplies: cleanStringList(body.commentReplies, { max: MAX_REPLIES, maxLength: 300 }),
    sendDm: canDm && Boolean(body.sendDm),
    dmMessage: canDm ? String(body.dmMessage || '').trim().slice(0, 1000) : '',
  };

  if (!payload.name) return { error: 'Give the automation a name.' };
  if (payload.mediaScope === 'specific' && payload.mediaIds.length === 0) {
    return { error: 'Pick at least one post, or apply the automation to all posts.' };
  }
  if (payload.triggerType === 'keywords' && payload.keywords.length === 0) {
    return { error: 'Add at least one keyword, or trigger on every comment.' };
  }
  if (payload.sendDm && !payload.dmMessage) return { error: 'Write the DM message.' };
  if (!payload.sendDm && payload.commentReplies.length === 0) {
    return { error: canDm ? 'Add a comment reply or turn on the DM.' : 'Add at least one comment reply.' };
  }
  return { payload };
};

const serializeAccount = (account) => ({
  _id: account._id,
  platform: account.platform,
  name: account.name,
  username: account.username,
  avatarUrl: account.avatarUrl,
  tokenStatus: account.tokenStatus,
  hasAutomationScopes: hasAutomationScopes(account),
  supportsDm: supportsDm(account.platform),
  // Accounts subscribed before DMs were added must subscribe again to receive messages.
  // Polled platforms (YouTube) have nothing to subscribe to, so they are ready once connected.
  subscribedAt: hasCurrentWebhookSubscription(account)
    ? account.metadata?.automationSubscribedAt || account.createdAt
    : null,
});

// @desc    Instagram accounts and Facebook Pages available for automation, with readiness status
// @route   GET /api/automations/accounts
// @access  Private
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await SocialAccount.find(await getManageableAccountQuery(req)).sort({ name: 1 });
    res.status(200).json(accounts.map(serializeAccount));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Subscribe an account to comment webhooks
// @route   POST /api/automations/accounts/:id/subscribe
// @access  Private
router.post('/accounts/:id/subscribe', async (req, res) => {
  try {
    const account = await findManageableAccount(req, req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (!hasAutomationScopes(account)) {
      return res.status(400).json({ message: 'Reconnect this account to grant comment and message access.' });
    }
    const updated = await subscribeAccountToWebhooks(account);
    res.status(200).json(serializeAccount(updated));
  } catch (error) {
    sendProviderError(res, req, error);
  }
});

// @desc    Recent posts of an account, for picking which posts a rule applies to
// @route   GET /api/automations/accounts/:id/media
// @access  Private
router.get('/accounts/:id/media', async (req, res) => {
  try {
    const account = await findManageableAccount(req, req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    const media = await fetchRecentMedia(account);
    res.status(200).json(media);
  } catch (error) {
    sendProviderError(res, req, error);
  }
});

// @desc    Comments (with replies) on one of an account's posts
// @route   GET /api/automations/accounts/:id/media/:mediaId/comments
// @access  Private
router.get('/accounts/:id/media/:mediaId/comments', async (req, res) => {
  try {
    const account = await findManageableAccount(req, req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (!isValidObjectId(account.platform, req.params.mediaId)) {
      return res.status(400).json({ message: 'Invalid post ID.' });
    }
    const comments = await fetchMediaComments(account, req.params.mediaId);
    const dmSentIds = new Set((await AutomationEvent.find({
      socialAccountId: account._id,
      commentId: { $in: comments.map((comment) => String(comment.id)) },
      dmStatus: 'sent',
    }).select('commentId').lean()).map((event) => event.commentId));
    res.status(200).json(comments.map((comment) => ({ ...comment, dmSent: dmSentIds.has(String(comment.id)) })));
  } catch (error) {
    sendProviderError(res, req, error);
  }
});

// @desc    Reply publicly to a comment as the account
// @route   POST /api/automations/comments/:commentId/reply
// @access  Private
router.post('/comments/:commentId/reply', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ message: 'Write a reply first.' });
    if (message.length > 2200) return res.status(400).json({ message: 'Replies can be at most 2,200 characters.' });

    const account = await findManageableAccount(req, req.body?.accountId);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (!isValidObjectId(account.platform, req.params.commentId)) {
      return res.status(400).json({ message: 'Invalid comment ID.' });
    }
    const result = await replyToComment(account, req.params.commentId, message);
    await recordOwnReply(account, {
      commentId: result.id,
      // YouTube reply IDs are "parent.child"; Instagram and Facebook replies go to the given comment
      parentId: account.platform === 'youtube' ? req.params.commentId.split('.')[0] : req.params.commentId,
      text: message,
    });
    res.status(201).json({ id: result.id, message });
  } catch (error) {
    sendProviderError(res, req, error);
  }
});

// @desc    Send a private DM to the person who wrote a comment
// @route   POST /api/automations/comments/:commentId/dm
// @access  Private
router.post('/comments/:commentId/dm', async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ message: 'Write a message first.' });
    if (message.length > 1000) return res.status(400).json({ message: 'DMs can be at most 1,000 characters.' });

    const account = await findManageableAccount(req, req.body?.accountId);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (!supportsDm(account.platform)) return res.status(400).json({ message: 'This platform does not support direct messages.' });
    if (!isValidObjectId(account.platform, commentId)) {
      return res.status(400).json({ message: 'Invalid comment ID.' });
    }

    const eventFilter = { platform: account.platform, socialAccountId: account._id, commentId };
    // Instagram and Facebook only allow one private reply per comment
    if (await AutomationEvent.exists({ ...eventFilter, dmStatus: 'sent' })) {
      return res.status(409).json({ message: 'A DM was already sent for this comment.' });
    }
    // Private replies are only allowed within 7 days of the comment; comments we haven't stored are left to the platform
    const storedComment = await SocialComment.findOne({ socialAccountId: account._id, commentId }).select('commentedAt').lean();
    if (storedComment?.commentedAt && Date.now() - new Date(storedComment.commentedAt).getTime() >= PRIVATE_REPLY_WINDOW_MS) {
      return res.status(400).json({ message: 'DMs can only be sent within 7 days of the comment.' });
    }

    await sendPrivateReply(account, commentId, message);
    await AutomationEvent.findOneAndUpdate(
      eventFilter,
      {
        $set: { dmStatus: 'sent', error: '' },
        $setOnInsert: {
          userId: req.user._id,
          mediaId: String(req.body?.mediaId || '').slice(0, 64),
          commenterUsername: String(req.body?.commenterUsername || '').slice(0, 100),
          commentText: String(req.body?.commentText || '').slice(0, 2000),
          replyStatus: 'skipped',
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ message: 'DM sent.' });
  } catch (error) {
    sendProviderError(res, req, error);
  }
});

// ─── Recent comments ──────────────────────────────────────────────────────────

const getRequestedAccountIds = async (req) => {
  const accountId = req.query.accountId || req.body?.accountId;
  if (!accountId) return getManageableAccountIds(req);
  const account = await findManageableAccount(req, accountId);
  return account ? [account._id] : null;
};

// @desc    Newest comments across all posts, with reply / DM status
// @route   GET /api/automations/comments/recent?accountId=&limit=
// @access  Private
router.get('/comments/recent', async (req, res) => {
  try {
    const accountIds = await getRequestedAccountIds(req);
    if (!accountIds) return res.status(404).json({ message: 'Account not found.' });
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

    const feedFilter = { socialAccountId: { $in: accountIds }, isOwn: { $ne: true }, ...visibleEngagementFilter() };
    const [comments, unseenCount] = await Promise.all([
      SocialComment.find(feedFilter).sort({ commentedAt: -1 }).limit(limit).lean(),
      SocialComment.countDocuments({ ...feedFilter, unseen: true }),
    ]);

    // The account's own replies, shown inside the thread of the comment they answer
    const threadIdOf = (comment) => comment.parentId || comment.commentId;
    const ownReplies = await SocialComment.find({
      ...visibleEngagementFilter(),
      socialAccountId: { $in: accountIds },
      isOwn: true,
      parentId: { $in: [...new Set(comments.map(threadIdOf))] },
    }).sort({ commentedAt: 1 }).lean();
    const repliesFor = (comment) => ownReplies
      .filter((reply) => (
        String(reply.socialAccountId) === String(comment.socialAccountId)
        && reply.parentId === threadIdOf(comment)
        // In a thread, only show replies written after this comment
        && (!comment.parentId || new Date(reply.commentedAt) >= new Date(comment.commentedAt))
      ))
      .map((reply) => ({ id: reply.commentId, text: reply.text, timestamp: reply.commentedAt }));
    const dmSentKeys = new Set((await AutomationEvent.find({
      socialAccountId: { $in: accountIds },
      commentId: { $in: comments.map((comment) => comment.commentId) },
      dmStatus: 'sent',
    }).select('socialAccountId commentId').lean()).map((event) => `${event.socialAccountId}:${event.commentId}`));

    res.status(200).json({
      unseenCount,
      comments: comments.map((comment) => ({
        id: comment.commentId,
        socialAccountId: comment.socialAccountId,
        platform: comment.platform,
        mediaId: comment.mediaId,
        parentId: comment.parentId,
        text: comment.text,
        username: comment.username,
        name: comment.name,
        timestamp: comment.commentedAt,
        ownerReplied: comment.ownerReplied,
        unseen: comment.unseen,
        dmSent: dmSentKeys.has(`${comment.socialAccountId}:${comment.commentId}`),
        replies: repliesFor(comment),
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Backfill comments from the latest posts (throttled unless force)
// @route   POST /api/automations/comments/recent/sync
// @access  Private
router.post('/comments/recent/sync', async (req, res) => {
  try {
    const account = await findManageableAccount(req, req.body?.accountId);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (!hasAutomationScopes(account)) {
      return res.status(400).json({ message: 'Reconnect this account to grant comment access.' });
    }
    const result = await syncRecentComments(account, { force: Boolean(req.body?.force) });
    res.status(200).json(result);
  } catch (error) {
    sendProviderError(res, req, error);
  }
});

// @desc    Mark recent comments as seen
// @route   POST /api/automations/comments/recent/seen
// @access  Private
router.post('/comments/recent/seen', async (req, res) => {
  try {
    const accountIds = await getRequestedAccountIds(req);
    if (!accountIds) return res.status(404).json({ message: 'Account not found.' });
    await SocialComment.updateMany({ socialAccountId: { $in: accountIds }, unseen: true }, { $set: { unseen: false } });
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── Inbox ────────────────────────────────────────────────────────────────────

const serializeConversation = (conversation) => ({
  _id: conversation._id,
  socialAccountId: conversation.socialAccountId,
  platform: conversation.platform,
  participantId: conversation.participantId,
  participantUsername: conversation.participantUsername,
  participantName: conversation.participantName,
  participantAvatarUrl: conversation.participantAvatarUrl,
  lastMessageText: conversation.lastMessageText,
  lastMessageDirection: conversation.lastMessageDirection,
  lastMessageAt: conversation.lastMessageAt,
  unreadCount: conversation.unreadCount,
  canReply: isReplyWindowOpen(conversation),
  replyWindowClosesAt: getReplyWindowClosesAt(conversation),
});

const findManageableConversation = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return null;
  const account = await findManageableAccount(req, conversation.socialAccountId);
  return account ? { conversation, account } : null;
};

// @desc    DM conversations, newest first
// @route   GET /api/automations/inbox/conversations?accountId=
// @access  Private
router.get('/inbox/conversations', async (req, res) => {
  try {
    let accountIds;
    if (req.query.accountId) {
      const account = await findManageableAccount(req, req.query.accountId);
      if (!account) return res.status(404).json({ message: 'Account not found.' });
      accountIds = [account._id];
    } else {
      accountIds = await getManageableAccountIds(req);
    }
    const conversations = await Conversation.find({ socialAccountId: { $in: accountIds }, lastMessageAt: { $ne: null } })
      .sort({ lastMessageAt: -1 })
      .limit(100);
    res.status(200).json(conversations.map(serializeConversation));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Pull recent DM threads from Instagram / Messenger (throttled unless force)
// @route   POST /api/automations/inbox/accounts/:id/sync
// @access  Private
router.post('/inbox/accounts/:id/sync', async (req, res) => {
  try {
    const account = await findManageableAccount(req, req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (!supportsDm(account.platform)) return res.status(400).json({ message: 'This platform does not support direct messages.' });
    if (!hasAutomationScopes(account)) {
      return res.status(400).json({ message: 'Reconnect this account to grant message access.' });
    }
    const result = await syncConversations(account, { force: Boolean(req.body?.force) });
    res.status(200).json(result);
  } catch (error) {
    sendProviderError(res, req, error);
  }
});

// @desc    Messages in a conversation (oldest first); marks it read
// @route   GET /api/automations/inbox/conversations/:id/messages
// @access  Private
router.get('/inbox/conversations/:id/messages', async (req, res) => {
  try {
    const found = await findManageableConversation(req);
    if (!found) return res.status(404).json({ message: 'Conversation not found.' });
    const { conversation } = found;

    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ sentAt: -1 })
      .limit(100)
      .lean();
    if (conversation.unreadCount > 0) {
      await Conversation.updateOne({ _id: conversation._id }, { $set: { unreadCount: 0 } });
      conversation.unreadCount = 0;
    }
    res.status(200).json({
      conversation: serializeConversation(conversation),
      messages: messages.reverse().map((message) => ({
        _id: message._id,
        mid: message.mid,
        direction: message.direction,
        text: message.text,
        attachments: message.attachments,
        sentAt: message.sentAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Send a DM in a conversation (only within Meta's 24-hour reply window)
// @route   POST /api/automations/inbox/conversations/:id/messages
// @access  Private
router.post('/inbox/conversations/:id/messages', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ message: 'Write a message first.' });
    if (text.length > 1000) return res.status(400).json({ message: 'Messages can be at most 1,000 characters.' });

    const found = await findManageableConversation(req);
    if (!found) return res.status(404).json({ message: 'Conversation not found.' });
    const message = await sendConversationMessage(found.account, found.conversation, text, req.user._id);
    res.status(201).json(message);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

// @desc    List automation rules
// @route   GET /api/automations/rules
// @access  Private
router.get('/rules', async (req, res) => {
  try {
    const accountIds = await getManageableAccountIds(req);
    const rules = await AutomationRule.find({ socialAccountId: { $in: accountIds } }).sort({ createdAt: -1 });
    res.status(200).json(rules);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create an automation rule
// @route   POST /api/automations/rules
// @access  Private
router.post('/rules', async (req, res) => {
  try {
    const account = await findManageableAccount(req, req.body?.socialAccountId);
    if (!account) return res.status(404).json({ message: 'Account not found.' });

    const { payload, error } = buildRulePayload(req.body, account.platform);
    if (error) return res.status(400).json({ message: error });

    const rule = await AutomationRule.create({
      ...payload,
      userId: req.user._id,
      socialAccountId: account._id,
      platform: account.platform,
    });
    res.status(201).json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const findManageableRule = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  const accountIds = await getManageableAccountIds(req);
  return AutomationRule.findOne({ _id: req.params.id, socialAccountId: { $in: accountIds } });
};

// @desc    Update an automation rule (full edit, or just { enabled })
// @route   PATCH /api/automations/rules/:id
// @access  Private
router.patch('/rules/:id', async (req, res) => {
  try {
    const rule = await findManageableRule(req);
    if (!rule) return res.status(404).json({ message: 'Automation not found.' });

    const keys = Object.keys(req.body || {});
    if (keys.length === 1 && keys[0] === 'enabled') {
      rule.enabled = Boolean(req.body.enabled);
    } else {
      const { payload, error } = buildRulePayload({ ...rule.toObject(), ...req.body }, rule.platform);
      if (error) return res.status(400).json({ message: error });
      rule.set(payload);
    }
    await rule.save();
    res.status(200).json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete an automation rule
// @route   DELETE /api/automations/rules/:id
// @access  Private
router.delete('/rules/:id', async (req, res) => {
  try {
    const rule = await findManageableRule(req);
    if (!rule) return res.status(404).json({ message: 'Automation not found.' });
    await rule.deleteOne();
    res.status(200).json({ message: 'Automation deleted.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Recent automation activity
// @route   GET /api/automations/events
// @access  Private
router.get('/events', async (req, res) => {
  try {
    const accountIds = await getManageableAccountIds(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const filter = { socialAccountId: { $in: accountIds }, ...visibleEngagementFilter() };
    if (req.query.ruleId && mongoose.isValidObjectId(req.query.ruleId)) filter.ruleId = req.query.ruleId;
    const events = await AutomationEvent.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.status(200).json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
