import AutomationRule from '../models/AutomationRule.js';
import AutomationEvent from '../models/AutomationEvent.js';
import SocialAccount from '../models/SocialAccount.js';
import SocialComment from '../models/SocialComment.js';
import { visibleEngagementFilter, youtubeEngagementExpiry } from '../utils/engagementRetention.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from './tokenHealthService.js';
import { findAccountsForEntry, getOwnIds, getProvider, supportsDm } from './socialProviders/index.js';

const normalizeText = (value) => String(value || '').toLowerCase().normalize('NFKC');

export const ruleMatchesComment = (rule, { mediaId, text, commentedAt }) => {
  if (!rule.enabled) return false;
  const activeSince = rule.enabledAt || rule.createdAt;
  if (commentedAt && activeSince && new Date(commentedAt) < new Date(activeSince)) return false;
  if (rule.mediaScope === 'specific' && !rule.mediaIds.includes(String(mediaId))) return false;
  if (rule.triggerType === 'any') return true;

  const comment = normalizeText(text);
  return rule.keywords.some((keyword) => {
    const needle = normalizeText(keyword).trim();
    if (!needle) return false;
    // Whole-word match so "info" doesn't fire on "information"
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(comment);
  });
};

// Instagram has @handles; Facebook only exposes a display name
export const fillTemplate = (template, { username, name } = {}) => (
  String(template || '')
    .replace(/\{\{\s*username\s*\}\}/gi, username ? `@${username}` : name || '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
);

const pickRandom = (items) => items[Math.floor(Math.random() * items.length)];

/**
 * Handles one incoming comment: finds the first matching enabled rule for each account
 * that owns the commented post, replies publicly and/or sends a private reply DM.
 */
export const processComment = async (comment, { socialAccountId } = {}) => {
  // Replies inside a thread (including our own public replies) never trigger automations
  if (comment.parentId) return { handled: 0, reason: 'reply_comment' };

  const platform = comment.platform || 'instagram';
  const accounts = await findAccountsForEntry(platform, comment.entryId);
  let handled = 0;

  for (const account of accounts) {
    if (socialAccountId && String(account._id) !== String(socialAccountId)) continue;
    if ([...getOwnIds(account), comment.entryId].includes(comment.fromId)) continue;

    const rules = await AutomationRule.find({ socialAccountId: account._id, enabled: true }).sort({ createdAt: 1 });
    const rule = rules.find((candidate) => ruleMatchesComment(candidate, comment));
    if (!rule) continue;

    let event;
    try {
      event = await AutomationEvent.create({
        ruleId: rule._id,
        userId: rule.userId,
        socialAccountId: account._id,
        platform,
        ...youtubeEngagementExpiry(platform),
        commentId: comment.commentId,
        mediaId: comment.mediaId,
        commenterId: comment.fromId,
        commenterUsername: comment.fromUsername || comment.fromName || '',
        commentText: comment.text.slice(0, 2000),
        replyStatus: rule.commentReplies.length ? 'pending' : 'skipped',
        dmStatus: rule.sendDm && rule.dmMessage && supportsDm(platform) ? 'pending' : 'skipped',
      });
    } catch (error) {
      if (error?.code === 11000) continue; // already handled (webhook retry)
      throw error;
    }

    const errors = [];
    let freshAccount;
    try {
      freshAccount = await ensureFreshAccountToken(account);
    } catch (error) {
      event.replyStatus = event.replyStatus === 'pending' ? 'failed' : event.replyStatus;
      event.dmStatus = event.dmStatus === 'pending' ? 'failed' : event.dmStatus;
      event.error = error.message;
      await event.save();
      continue;
    }
    const provider = getProvider(platform);
    const templateContext = { username: comment.fromUsername, name: comment.fromName };

    if (event.replyStatus === 'pending') {
      const replyText = fillTemplate(pickRandom(rule.commentReplies), templateContext);
      event.replyText = replyText;
      try {
        await provider.replyToComment(freshAccount, comment.commentId, replyText);
        event.replyStatus = 'sent';
      } catch (error) {
        event.replyStatus = 'failed';
        errors.push(`Reply: ${error.message}`);
        await handleProviderAuthFailure(freshAccount, error.data, error.message);
      }
    }

    if (event.dmStatus === 'pending') {
      try {
        // Private reply: one DM per comment, allowed within 7 days of the comment
        await provider.sendPrivateReply(freshAccount, comment.commentId, fillTemplate(rule.dmMessage, templateContext));
        event.dmStatus = 'sent';
      } catch (error) {
        event.dmStatus = 'failed';
        errors.push(`DM: ${error.message}`);
        await handleProviderAuthFailure(freshAccount, error.data, error.message);
      }
    }

    event.error = errors.join(' | ').slice(0, 1000);
    await event.save();
    await AutomationRule.updateOne(
      { _id: rule._id },
      { $inc: { triggeredCount: 1 }, $set: { lastTriggeredAt: new Date() } }
    );
    handled += 1;
  }

  return { handled };
};

// Queue payloads contain only record references, never comment text or profiles.
export const processStoredComment = async ({ socialAccountId, socialCommentId } = {}) => {
  if (!socialAccountId || !socialCommentId) return { handled: 0 };
  const account = await SocialAccount.findOne({ _id: socialAccountId, isConnected: true });
  if (!account) return { handled: 0 };
  const comment = await SocialComment.findOne({
    _id: socialCommentId, socialAccountId, ...visibleEngagementFilter(),
  });
  if (!comment || comment.isOwn) return { handled: 0 };
  return processComment({
    platform: account.platform,
    entryId: String(account.accountId),
    commentId: comment.commentId,
    parentId: comment.parentId,
    mediaId: comment.mediaId,
    text: comment.text,
    commentedAt: comment.commentedAt,
    fromId: comment.commenterId,
    fromUsername: comment.username,
    fromName: comment.name,
  }, { socialAccountId });
};
