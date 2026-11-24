import express from 'express';
import mongoose from 'mongoose';
import { getDBStatus } from '../config/db.js';
import { protect, authorize } from '../middleware/auth.js';
import AutomationRule from '../models/AutomationRule.js';
import AutomationEvent from '../models/AutomationEvent.js';
import SocialAccount from '../models/SocialAccount.js';
import SocialComment from '../models/SocialComment.js';
import { visibleEngagementFilter } from '../utils/engagementRetention.js';
import { fetchRecentMedia } from '../services/socialProviders/index.js';
import {
  applyRuleUpdate,
  buildRulePayload,
  sendProviderError,
  serializeAccount,
} from '../services/automationRules.js';
import {
  buildCommentFilter,
  buildEventFilter,
  buildRuleFilter,
  cleanAccountIds,
  findAdminAccount,
  findAdminCampaign,
  getCampaignAccountQuery,
  loadScopedAccounts,
  prepareRulesForAccounts,
  setRulesEnabled,
  summarizeAutomations,
} from '../services/adminAutomationService.js';

// Admin view of the automations on every account in one campaign (?campaignId=).
// Handlers keep using /api/automations, which is scoped to their own accounts.

const router = express.Router();

// Account handlers manage their own automations; they never get the workspace-wide view
export const requireAdminPanelUser = (req, res, next) => {
  if (req.user?.userType === 'account_handler') {
    return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
  }
  if (!getDBStatus()) return res.status(503).json({ message: 'Database disconnected.' });
  return next();
};

// Every request names the campaign it is about (?campaignId=), like the other admin pages
export const requireAdminCampaign = async (req, res, next) => {
  try {
    if (!req.query?.campaignId) return res.status(400).json({ message: 'Pick a campaign first.' });
    req.campaign = await findAdminCampaign(req);
    if (!req.campaign) return res.status(404).json({ message: 'Campaign not found.' });
    return next();
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

router.use(protect, authorize('owner', 'admin'), requireAdminPanelUser, requireAdminCampaign);

const toKey = (value) => (value == null ? '' : String(value));

const withAccountContext = (rule, context) => ({
  ...(typeof rule.toObject === 'function' ? rule.toObject() : rule),
  ...(context[toKey(rule.socialAccountId)] || { owner: null, handlers: [] }),
});

const findAdminRule = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  const rule = await AutomationRule.findById(req.params.id);
  if (!rule) return null;
  return (await findAdminAccount(req, rule.socialAccountId)) ? rule : null;
};

// @desc    Totals for the header: rules, triggers, sent/failed replies and DMs (24h, 7d)
// @route   GET /api/admin/automations/summary
// @access  Private (Owner, Admin)
router.get('/summary', async (req, res) => {
  try {
    const { accounts } = await loadScopedAccounts(req);
    res.status(200).json(await summarizeAutomations(accounts.map((account) => account._id)));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    The campaign's accounts with readiness, owner and handlers
// @route   GET /api/admin/automations/accounts?campaignId&handlerId&platform
// @access  Private (Owner, Admin)
router.get('/accounts', async (req, res) => {
  try {
    const { accounts, context } = await loadScopedAccounts(req);
    res.status(200).json(accounts.map((account) => ({
      ...serializeAccount(account),
      ...context[toKey(account._id)],
    })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Recent posts of an account, for the rule editor's post picker
// @route   GET /api/admin/automations/accounts/:id/media
// @access  Private (Owner, Admin)
router.get('/accounts/:id/media', async (req, res) => {
  try {
    const account = await findAdminAccount(req, req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    res.status(200).json(await fetchRecentMedia(account));
  } catch (error) {
    sendProviderError(res, req, error);
  }
});

// @desc    The campaign's rules, each with its account's owner and handlers
// @route   GET /api/admin/automations/rules?campaignId&handlerId&accountId&platform&status&q
// @access  Private (Owner, Admin)
router.get('/rules', async (req, res) => {
  try {
    const { accounts, context } = await loadScopedAccounts(req);
    const rules = await AutomationRule.find(buildRuleFilter(accounts.map((account) => account._id), req.query))
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json(rules.map((rule) => withAccountContext(rule, context)));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create a rule on any account in scope. It belongs to the account's owner.
// @route   POST /api/admin/automations/rules
// @access  Private (Owner, Admin)
router.post('/rules', async (req, res) => {
  try {
    const account = await findAdminAccount(req, req.body?.socialAccountId);
    if (!account) return res.status(404).json({ message: 'Account not found.' });

    const { payload, error } = buildRulePayload(req.body, account.platform);
    if (error) return res.status(400).json({ message: error });

    const rule = await AutomationRule.create({
      ...payload,
      userId: account.userId,
      createdBy: req.user._id,
      socialAccountId: account._id,
      platform: account.platform,
    });
    res.status(201).json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create the same rule on several accounts: { socialAccountIds: [...], ...rule }
// @route   POST /api/admin/automations/rules/batch
// @access  Private (Owner, Admin)
router.post('/rules/batch', async (req, res) => {
  try {
    const ids = cleanAccountIds(req.body?.socialAccountIds);
    if (!ids.length) return res.status(400).json({ message: 'Pick at least one account.' });
    const accounts = await SocialAccount.find({ _id: { $in: ids }, ...(await getCampaignAccountQuery(req.campaign)) });
    if (accounts.length !== ids.length) {
      return res.status(404).json({ message: 'Some of these accounts are not in this campaign.' });
    }
    const { docs, error } = prepareRulesForAccounts(accounts, req.body, req.user._id);
    if (error) return res.status(400).json({ message: error });
    const rules = await AutomationRule.insertMany(docs);
    res.status(201).json({ created: rules.length, rules });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Pause or resume many rules: { ids: [...], enabled: boolean }
// @route   POST /api/admin/automations/rules/bulk
// @access  Private (Owner, Admin)
router.post('/rules/bulk', async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ message: 'Say whether to pause or resume.' });
    }
    // The campaign only, not the panel filters, so a stale filter can't hide a selected rule
    const { accounts } = await loadScopedAccounts(req, {});
    const result = await setRulesEnabled(
      req.body.ids,
      req.body.enabled,
      accounts.map((account) => account._id),
      req.user._id,
    );
    if (result.error) return res.status(400).json({ message: result.error });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    One rule of the campaign, for the edit page
// @route   GET /api/admin/automations/rules/:id
// @access  Private (Owner, Admin)
router.get('/rules/:id', async (req, res) => {
  try {
    const rule = await findAdminRule(req);
    if (!rule) return res.status(404).json({ message: 'Automation not found.' });
    res.status(200).json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Edit a rule (full edit, or just { enabled })
// @route   PATCH /api/admin/automations/rules/:id
// @access  Private (Owner, Admin)
router.patch('/rules/:id', async (req, res) => {
  try {
    const rule = await findAdminRule(req);
    if (!rule) return res.status(404).json({ message: 'Automation not found.' });
    const { error } = applyRuleUpdate(rule, req.body || {}, req.user._id);
    if (error) return res.status(400).json({ message: error });
    await rule.save();
    res.status(200).json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete a rule
// @route   DELETE /api/admin/automations/rules/:id
// @access  Private (Owner, Admin)
router.delete('/rules/:id', async (req, res) => {
  try {
    const rule = await findAdminRule(req);
    if (!rule) return res.status(404).json({ message: 'Automation not found.' });
    await rule.deleteOne();
    res.status(200).json({ message: 'Automation deleted.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Activity log, newest first, paged with ?before=<createdAt of the last item>
// @route   GET /api/admin/automations/events?status=failed&ruleId&accountId&campaignId&handlerId&before&limit
// @access  Private (Owner, Admin)
router.get('/events', async (req, res) => {
  try {
    const { accounts } = await loadScopedAccounts(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const events = await AutomationEvent.find(buildEventFilter(accounts.map((account) => account._id), req.query))
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    // Rule names travel with the events, since the page's rule list may be filtered
    const ruleIds = [...new Set(events.map((event) => toKey(event.ruleId)).filter(Boolean))];
    const rules = ruleIds.length ? await AutomationRule.find({ _id: { $in: ruleIds } }).select('name').lean() : [];
    const namesById = new Map(rules.map((rule) => [toKey(rule._id), rule.name]));
    res.status(200).json({
      events: events.map((event) => ({ ...event, ruleName: namesById.get(toKey(event.ruleId)) || '' })),
      nextBefore: events.length === limit ? events[events.length - 1].createdAt : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Comments others left on every account in scope, newest first, read-only.
//          Paged with ?before=<timestamp of the last item>. Doesn't clear the handlers' "new" marks.
// @route   GET /api/admin/automations/comments?campaignId&handlerId&accountId&platform&status&q&before&limit
// @access  Private (Owner, Admin)
router.get('/comments', async (req, res) => {
  try {
    const { accounts } = await loadScopedAccounts(req);
    const accountIds = accounts.map((account) => account._id);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const comments = await SocialComment.find(buildCommentFilter(accountIds, req.query))
      .sort({ commentedAt: -1 })
      .limit(limit)
      .lean();

    // The account's own replies, shown inside the thread of the comment they answer
    const threadIdOf = (comment) => comment.parentId || comment.commentId;
    const ownReplies = comments.length ? await SocialComment.find({
      ...visibleEngagementFilter(),
      socialAccountId: { $in: accountIds },
      isOwn: true,
      parentId: { $in: [...new Set(comments.map(threadIdOf))] },
    }).sort({ commentedAt: 1 }).lean() : [];
    const repliesFor = (comment) => ownReplies
      .filter((reply) => (
        toKey(reply.socialAccountId) === toKey(comment.socialAccountId)
        && reply.parentId === threadIdOf(comment)
        && (!comment.parentId || new Date(reply.commentedAt) >= new Date(comment.commentedAt))
      ))
      .map((reply) => ({ id: reply.commentId, text: reply.text, timestamp: reply.commentedAt }));

    // Which automation (if any) answered each comment
    const events = comments.length ? await AutomationEvent.find({
      socialAccountId: { $in: accountIds },
      commentId: { $in: comments.map((comment) => comment.commentId) },
    }).select('socialAccountId commentId ruleId replyStatus dmStatus').lean() : [];
    const ruleIds = [...new Set(events.map((event) => toKey(event.ruleId)).filter(Boolean))];
    const rules = ruleIds.length ? await AutomationRule.find({ _id: { $in: ruleIds } }).select('name').lean() : [];
    const ruleNames = new Map(rules.map((rule) => [toKey(rule._id), rule.name]));
    const eventsByComment = new Map(events.map((event) => [`${event.socialAccountId}:${event.commentId}`, event]));

    res.status(200).json({
      comments: comments.map((comment) => {
        const event = eventsByComment.get(`${comment.socialAccountId}:${comment.commentId}`);
        return {
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
          dmSent: event?.dmStatus === 'sent',
          automation: event ? {
            ruleName: ruleNames.get(toKey(event.ruleId)) || '',
            replyStatus: event.replyStatus,
            dmStatus: event.dmStatus,
          } : null,
          replies: repliesFor(comment),
        };
      }),
      nextBefore: comments.length === limit ? comments[comments.length - 1].commentedAt : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
