import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignChannel from '../models/CampaignChannel.js';
import SocialAccount from '../models/SocialAccount.js';
import AutomationRule from '../models/AutomationRule.js';
import AutomationEvent from '../models/AutomationEvent.js';
import User from '../models/User.js';
import { AUTOMATION_PLATFORMS } from './socialProviders/index.js';
import { buildRulePayload } from './automationRules.js';
import { getCampaignAccessQuery } from '../utils/campaignAccess.js';
import { visibleEngagementFilter } from '../utils/engagementRetention.js';

// Scope and reporting helpers for the admin automations panel (/api/admin/automations).
// Everything is scoped to one campaign, like the rest of the admin panel.

const DAY_MS = 24 * 60 * 60 * 1000;
const toKey = (value) => (value == null ? '' : String(value));
const uniqueIds = (values) => [...new Map(values.filter(Boolean).map((value) => [toKey(value), value])).values()];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The campaign the admin panel is looking at (`?campaignId=`), if this admin may access it.
 * Like the rest of the admin panel, automations are always viewed one campaign at a time.
 */
export const findAdminCampaign = async (req) => {
  const campaignId = req.query?.campaignId;
  if (!mongoose.isValidObjectId(campaignId)) return null;
  return Campaign.findOne({
    _id: campaignId,
    ...getCampaignAccessQuery(req, { forceWorkspaceScope: req.query?.scope === 'workspace' }),
  }).select('_id name accountIds channels.socialAccountId').lean();
};

/** Connected automation accounts linked to the campaign, the same links the Team page uses. */
export const getCampaignAccountQuery = async (campaign) => {
  const channelIds = await CampaignChannel.distinct('socialAccountId', {
    campaignId: campaign._id,
    socialAccountId: { $ne: null },
  });
  const linkedIds = uniqueIds([
    ...(campaign.accountIds || []),
    ...(campaign.channels || []).map((channel) => channel.socialAccountId),
    ...channelIds,
  ]);
  return {
    platform: { $in: AUTOMATION_PLATFORMS },
    isConnected: true,
    $or: [
      { campaignId: campaign._id },
      { _id: { $in: linkedIds } },
    ],
  };
};

/**
 * Who owns and handles each account in this campaign: { [accountId]: { owner, handlers } }.
 * Handlers come from the campaign's channel assignments; with none, the account owner handles it.
 */
export const getAccountContext = async (accounts, campaignId) => {
  const accountIds = accounts.map((account) => account._id);
  if (!accountIds.length) return {};

  const channels = await CampaignChannel.find({ campaignId, socialAccountId: { $in: accountIds } })
    .select('socialAccountId assignedHandlerUserId assignedHandlerEmail')
    .lean();
  const userIds = uniqueIds([
    ...accounts.map((account) => account.userId),
    ...channels.map((channel) => channel.assignedHandlerUserId),
  ]);
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('name email avatar').lean() : [];
  const usersById = new Map(users.map((user) => [toKey(user._id), user]));
  const describeUser = (user) => user && ({ _id: user._id, name: user.name, email: user.email, avatar: user.avatar });

  return Object.fromEntries(accounts.map((account) => {
    const handlers = [];
    for (const channel of channels.filter((item) => toKey(item.socialAccountId) === toKey(account._id))) {
      const user = describeUser(usersById.get(toKey(channel.assignedHandlerUserId)));
      const handler = user || (channel.assignedHandlerEmail ? { _id: null, name: '', email: channel.assignedHandlerEmail } : null);
      const key = toKey(handler?._id) || handler?.email;
      if (handler && !handlers.some((item) => (toKey(item._id) || item.email) === key)) handlers.push(handler);
    }
    const owner = describeUser(usersById.get(toKey(account.userId))) || null;
    return [toKey(account._id), { owner, handlers: handlers.length ? handlers : (owner ? [owner] : []) }];
  }));
};

/** Narrows accounts by the panel's filters: accountId, platform, handlerId (handler or owner). */
export const filterAccounts = (accounts, context, { accountId, platform, handlerId } = {}) => (
  accounts.filter((account) => {
    const info = context[toKey(account._id)] || { handlers: [], owner: null };
    if (accountId && toKey(account._id) !== toKey(accountId)) return false;
    if (platform && account.platform !== platform) return false;
    if (handlerId && toKey(info.owner?._id) !== toKey(handlerId)
      && !info.handlers.some((handler) => toKey(handler._id) === toKey(handlerId))) return false;
    return true;
  })
);

/**
 * The campaign's accounts (req.campaign, set by the router) narrowed by `filters`
 * (defaults to the query string), with their context.
 */
export const loadScopedAccounts = async (req, filters = req.query || {}) => {
  const accounts = await SocialAccount.find(await getCampaignAccountQuery(req.campaign)).sort({ name: 1 });
  const context = await getAccountContext(accounts, req.campaign._id);
  return { accounts: filterAccounts(accounts, context, filters), context };
};

/** One account of the campaign, or null. */
export const findAdminAccount = async (req, accountId) => {
  if (!mongoose.isValidObjectId(accountId)) return null;
  return SocialAccount.findOne({ _id: accountId, ...(await getCampaignAccountQuery(req.campaign)) });
};

/** Rule filters beyond account scope: status (active | paused) and a name search `q`. */
export const buildRuleFilter = (accountIds, { status, q } = {}) => {
  const filter = { socialAccountId: { $in: accountIds } };
  if (status === 'active') filter.enabled = true;
  if (status === 'paused') filter.enabled = false;
  const search = String(q || '').trim().slice(0, 100);
  if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
  return filter;
};

/** Activity filters: status=failed, ruleId, and `before` (createdAt cursor for paging). */
export const buildEventFilter = (accountIds, { status, ruleId, before } = {}, now = new Date()) => {
  const conditions = [visibleEngagementFilter(now)];
  if (status === 'failed') conditions.push({ $or: [{ replyStatus: 'failed' }, { dmStatus: 'failed' }] });
  const filter = { socialAccountId: { $in: accountIds }, $and: conditions };
  if (ruleId && mongoose.isValidObjectId(ruleId)) filter.ruleId = ruleId;
  const beforeDate = before ? new Date(before) : null;
  if (beforeDate && !Number.isNaN(beforeDate.getTime())) filter.createdAt = { $lt: beforeDate };
  return filter;
};

/**
 * Comments feed filters: others' comments only, status (unreplied | replied), a text or
 * commenter search `q`, and `before` (commentedAt cursor for paging).
 */
export const buildCommentFilter = (accountIds, { status, q, before } = {}, now = new Date()) => {
  const conditions = [visibleEngagementFilter(now)];
  const search = String(q || '').trim().slice(0, 100);
  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: 'i' };
    conditions.push({ $or: [{ text: pattern }, { username: pattern }, { name: pattern }] });
  }
  const filter = { socialAccountId: { $in: accountIds }, isOwn: { $ne: true }, $and: conditions };
  if (status === 'unreplied') filter.ownerReplied = { $ne: true };
  if (status === 'replied') filter.ownerReplied = true;
  const beforeDate = before ? new Date(before) : null;
  if (beforeDate && !Number.isNaN(beforeDate.getTime())) filter.commentedAt = { $lt: beforeDate };
  return filter;
};

const countIf = (field, value) => ({ $sum: { $cond: [{ $eq: [`$${field}`, value] }, 1, 0] } });

const eventStats = async (accountIds, since, now) => {
  const [row] = await AutomationEvent.aggregate([
    { $match: { socialAccountId: { $in: accountIds }, createdAt: { $gte: since }, ...visibleEngagementFilter(now) } },
    {
      $group: {
        _id: null,
        events: { $sum: 1 },
        repliesSent: countIf('replyStatus', 'sent'),
        repliesFailed: countIf('replyStatus', 'failed'),
        dmsSent: countIf('dmStatus', 'sent'),
        dmsFailed: countIf('dmStatus', 'failed'),
      },
    },
  ]);
  return {
    events: row?.events || 0,
    repliesSent: row?.repliesSent || 0,
    repliesFailed: row?.repliesFailed || 0,
    dmsSent: row?.dmsSent || 0,
    dmsFailed: row?.dmsFailed || 0,
  };
};

/** Header numbers for the admin page. */
export const summarizeAutomations = async (accountIds, now = new Date()) => {
  const [rules, last24h, last7d] = await Promise.all([
    AutomationRule.find({ socialAccountId: { $in: accountIds } }).select('enabled triggeredCount').lean(),
    eventStats(accountIds, new Date(now.getTime() - DAY_MS), now),
    eventStats(accountIds, new Date(now.getTime() - 7 * DAY_MS), now),
  ]);
  const active = rules.filter((rule) => rule.enabled).length;
  return {
    accounts: accountIds.length,
    rules: { total: rules.length, active, paused: rules.length - active },
    triggers: rules.reduce((sum, rule) => sum + (rule.triggeredCount || 0), 0),
    last24h,
    last7d,
  };
};

/**
 * Pauses or resumes many rules at once, only those inside the admin's scope.
 * Resuming sets enabledAt like the model's save hook does, so older comments aren't replayed.
 */
export const setRulesEnabled = async (ids, enabled, accountIds, updatedBy, now = new Date()) => {
  const ruleIds = uniqueIds((Array.isArray(ids) ? ids : []).filter((id) => mongoose.isValidObjectId(id))).slice(0, 200);
  if (!ruleIds.length) return { error: 'Pick at least one automation.' };
  const result = await AutomationRule.updateMany(
    { _id: { $in: ruleIds }, socialAccountId: { $in: accountIds }, enabled: !enabled },
    { $set: { enabled, updatedBy, ...(enabled ? { enabledAt: now } : {}) } },
  );
  return { updated: result.modifiedCount || 0 };
};

export const MAX_BATCH_ACCOUNTS = 100;

/** Valid, de-duplicated account ids from a request body (up to MAX_BATCH_ACCOUNTS). */
export const cleanAccountIds = (ids) => uniqueIds(
  (Array.isArray(ids) ? ids : []).map(toKey).filter((id) => mongoose.isValidObjectId(id)),
).slice(0, MAX_BATCH_ACCOUNTS);

/**
 * Builds one rule per account from the same form. All-or-nothing: if the form doesn't
 * work for any account (e.g. DM-only on YouTube, which has no DMs), nothing is created
 * and the error names that account. Each rule belongs to its account's owner.
 */
export const prepareRulesForAccounts = (accounts, body, createdBy, now = new Date()) => {
  const docs = [];
  for (const account of accounts) {
    const { payload, error } = buildRulePayload(body, account.platform);
    if (error) return { error: `${account.name || account.username || 'An account'}: ${error}` };
    docs.push({
      ...payload,
      userId: account.userId,
      createdBy,
      socialAccountId: account._id,
      platform: account.platform,
      // insertMany skips the model's save hook, which normally sets this
      ...(payload.enabled ? { enabledAt: now } : {}),
    });
  }
  return { docs };
};

