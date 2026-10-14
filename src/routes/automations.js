import express from 'express';
import mongoose from 'mongoose';
import { getDBStatus } from '../config/db.js';
import { protect, resolveHandlerPreview } from '../middleware/auth.js';
import SocialAccount from '../models/SocialAccount.js';
import CampaignChannel from '../models/CampaignChannel.js';
import AutomationRule from '../models/AutomationRule.js';
import AutomationEvent from '../models/AutomationEvent.js';
import {
  fetchRecentMedia,
  hasAutomationScopes,
  subscribeAccountToWebhooks,
} from '../services/instagramAutomationService.js';

const router = express.Router();

const MAX_KEYWORDS = 30;
const MAX_REPLIES = 10;
const MAX_MEDIA_IDS = 100;

router.use(protect, resolveHandlerPreview, (req, res, next) => {
  if (!getDBStatus()) {
    return res.status(503).json({ message: 'Database disconnected.' });
  }
  return next();
});

// Instagram accounts the user connected themselves or was assigned as handler
const getManageableAccountQuery = async (req) => {
  const handlerEmail = (req.user.email || '').trim().toLowerCase();
  const assignedChannels = await CampaignChannel.find({
    $or: [
      { assignedHandlerUserId: req.user._id },
      ...(handlerEmail ? [{ assignedHandlerEmail: handlerEmail }] : []),
    ],
  }).select('socialAccountId').lean();
  const assignedIds = assignedChannels.map((channel) => channel.socialAccountId).filter(Boolean);

  return {
    platform: 'instagram',
    isConnected: true,
    $or: [
      { userId: req.user._id },
      { _id: { $in: assignedIds } },
    ],
  };
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

const buildRulePayload = (body = {}) => {
  const payload = {
    name: String(body.name || '').trim().slice(0, 120),
    enabled: body.enabled !== false,
    mediaScope: body.mediaScope === 'specific' ? 'specific' : 'all',
    mediaIds: cleanStringList(body.mediaIds, { max: MAX_MEDIA_IDS, maxLength: 64 }),
    triggerType: body.triggerType === 'any' ? 'any' : 'keywords',
    keywords: cleanStringList(body.keywords, { max: MAX_KEYWORDS, maxLength: 60 }),
    commentReplies: cleanStringList(body.commentReplies, { max: MAX_REPLIES, maxLength: 300 }),
    sendDm: Boolean(body.sendDm),
    dmMessage: String(body.dmMessage || '').trim().slice(0, 1000),
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
    return { error: 'Add a comment reply or turn on the DM.' };
  }
  return { payload };
};

const serializeAccount = (account) => ({
  _id: account._id,
  name: account.name,
  username: account.username,
  avatarUrl: account.avatarUrl,
  tokenStatus: account.tokenStatus,
  hasAutomationScopes: hasAutomationScopes(account),
  subscribedAt: account.metadata?.automationSubscribedAt || null,
});

// @desc    Instagram accounts available for automation, with readiness status
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
    if (!account) return res.status(404).json({ message: 'Instagram account not found.' });
    if (!hasAutomationScopes(account)) {
      return res.status(400).json({ message: 'Reconnect this Instagram account to grant comment and message access.' });
    }
    const updated = await subscribeAccountToWebhooks(account);
    res.status(200).json(serializeAccount(updated));
  } catch (error) {
    res.status(502).json({ message: error.message });
  }
});

// @desc    Recent posts of an account, for picking which posts a rule applies to
// @route   GET /api/automations/accounts/:id/media
// @access  Private
router.get('/accounts/:id/media', async (req, res) => {
  try {
    const account = await findManageableAccount(req, req.params.id);
    if (!account) return res.status(404).json({ message: 'Instagram account not found.' });
    const media = await fetchRecentMedia(account);
    res.status(200).json(media);
  } catch (error) {
    res.status(502).json({ message: error.message });
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
    if (!account) return res.status(404).json({ message: 'Instagram account not found.' });

    const { payload, error } = buildRulePayload(req.body);
    if (error) return res.status(400).json({ message: error });

    const rule = await AutomationRule.create({
      ...payload,
      userId: req.user._id,
      socialAccountId: account._id,
      platform: 'instagram',
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
      const { payload, error } = buildRulePayload({ ...rule.toObject(), ...req.body });
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
    const filter = { socialAccountId: { $in: accountIds } };
    if (req.query.ruleId && mongoose.isValidObjectId(req.query.ruleId)) filter.ruleId = req.query.ruleId;
    const events = await AutomationEvent.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.status(200).json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
