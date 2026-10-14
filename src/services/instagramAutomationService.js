import { META_GRAPH_API_VERSION } from '../config/platforms.js';
import SocialAccount from '../models/SocialAccount.js';
import AutomationRule from '../models/AutomationRule.js';
import AutomationEvent from '../models/AutomationEvent.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from './tokenHealthService.js';

const GRAPH_BASE = `https://graph.instagram.com/${META_GRAPH_API_VERSION}`;

export const INSTAGRAM_AUTOMATION_SCOPES = [
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
];

const getGraphError = (data, fallback) => (
  data?.error?.message ? `${data.error.message}${data.error.code ? ` (code ${data.error.code})` : ''}` : fallback
);

const graphRequest = async (path, { method = 'GET', accessToken, body } = {}) => {
  const response = await fetch(`${GRAPH_BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const error = new Error(getGraphError(data, `Instagram request failed with status ${response.status}`));
    error.data = data;
    throw error;
  }
  return data;
};

/**
 * Webhooks identify the account by its Instagram professional account ID (`user_id`),
 * which can differ from the app-scoped `id` stored as accountId at connect time.
 */
export const resolveProfessionalAccountId = async (account) => {
  if (account.metadata?.instagramProfessionalId) return account.metadata.instagramProfessionalId;
  const data = await graphRequest('me?fields=user_id', { accessToken: account.getDecryptedAccessToken() });
  const professionalId = String(data.user_id || account.accountId);
  account.metadata = { ...(account.metadata || {}), instagramProfessionalId: professionalId };
  account.markModified('metadata');
  await account.save();
  return professionalId;
};

// Instagram only delivers comment webhooks for accounts that have subscribed the app.
export const subscribeAccountToWebhooks = async (account) => {
  const freshAccount = await ensureFreshAccountToken(account);
  const professionalId = await resolveProfessionalAccountId(freshAccount);
  try {
    await graphRequest(`${professionalId}/subscribed_apps?subscribed_fields=comments`, {
      method: 'POST',
      accessToken: freshAccount.getDecryptedAccessToken(),
    });
  } catch (error) {
    await handleProviderAuthFailure(freshAccount, error.data, error.message);
    throw error;
  }
  freshAccount.metadata = {
    ...(freshAccount.metadata || {}),
    automationSubscribedAt: new Date().toISOString(),
    automationSubscribeError: '',
  };
  freshAccount.markModified('metadata');
  await freshAccount.save();
  return freshAccount;
};

export const hasAutomationScopes = (account) => {
  const scopes = Array.isArray(account?.scopes) ? account.scopes : [];
  return INSTAGRAM_AUTOMATION_SCOPES.every((scope) => scopes.includes(scope));
};

export const fetchRecentMedia = async (account, limit = 24) => {
  const freshAccount = await ensureFreshAccountToken(account);
  const professionalId = await resolveProfessionalAccountId(freshAccount);
  const data = await graphRequest(
    `${professionalId}/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp&limit=${limit}`,
    { accessToken: freshAccount.getDecryptedAccessToken() }
  );
  return Array.isArray(data.data) ? data.data : [];
};

const normalizeText = (value) => String(value || '').toLowerCase().normalize('NFKC');

export const ruleMatchesComment = (rule, { mediaId, text }) => {
  if (!rule.enabled) return false;
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

export const fillTemplate = (template, { username }) => (
  String(template || '').replace(/\{\{\s*username\s*\}\}/gi, username ? `@${username}` : '').trim()
);

const pickRandom = (items) => items[Math.floor(Math.random() * items.length)];

/**
 * Normalizes one `comments` change from an Instagram webhook entry.
 * Returns null for changes that are not new comments we can act on.
 */
export const parseCommentChange = (entryId, change) => {
  if (change?.field !== 'comments' || !change.value?.id) return null;
  const value = change.value;
  return {
    entryId: String(entryId),
    commentId: String(value.id),
    parentId: value.parent_id ? String(value.parent_id) : '',
    mediaId: String(value.media?.id || ''),
    text: String(value.text || ''),
    fromId: String(value.from?.id || ''),
    fromUsername: String(value.from?.username || ''),
  };
};

const findAccountsForEntry = async (entryId) => SocialAccount.find({
  platform: 'instagram',
  isConnected: true,
  $or: [
    { accountId: entryId },
    { 'metadata.instagramProfessionalId': entryId },
  ],
});

/**
 * Handles one incoming comment: finds the first matching enabled rule for each account
 * that owns the commented media, replies publicly and/or sends a private reply DM.
 */
export const processInstagramComment = async (comment) => {
  // Replies inside a thread (including our own public replies) never trigger automations
  if (comment.parentId) return { handled: 0, reason: 'reply_comment' };

  const accounts = await findAccountsForEntry(comment.entryId);
  let handled = 0;

  for (const account of accounts) {
    const ownIds = [account.accountId, account.metadata?.instagramProfessionalId, comment.entryId].filter(Boolean).map(String);
    if (ownIds.includes(comment.fromId)) continue;

    const rules = await AutomationRule.find({ socialAccountId: account._id, enabled: true }).sort({ createdAt: 1 });
    const rule = rules.find((candidate) => ruleMatchesComment(candidate, comment));
    if (!rule) continue;

    let event;
    try {
      event = await AutomationEvent.create({
        ruleId: rule._id,
        userId: rule.userId,
        socialAccountId: account._id,
        commentId: comment.commentId,
        mediaId: comment.mediaId,
        commenterId: comment.fromId,
        commenterUsername: comment.fromUsername,
        commentText: comment.text.slice(0, 2000),
        replyStatus: rule.commentReplies.length ? 'pending' : 'skipped',
        dmStatus: rule.sendDm && rule.dmMessage ? 'pending' : 'skipped',
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
    const accessToken = freshAccount.getDecryptedAccessToken();
    const templateContext = { username: comment.fromUsername };

    if (event.replyStatus === 'pending') {
      const replyText = fillTemplate(pickRandom(rule.commentReplies), templateContext);
      event.replyText = replyText;
      try {
        await graphRequest(`${comment.commentId}/replies`, {
          method: 'POST',
          accessToken,
          body: { message: replyText },
        });
        event.replyStatus = 'sent';
      } catch (error) {
        event.replyStatus = 'failed';
        errors.push(`Reply: ${error.message}`);
        await handleProviderAuthFailure(freshAccount, error.data, error.message);
      }
    }

    if (event.dmStatus === 'pending') {
      try {
        const professionalId = await resolveProfessionalAccountId(freshAccount);
        // Private reply: one DM per comment, allowed within 7 days of the comment
        await graphRequest(`${professionalId}/messages`, {
          method: 'POST',
          accessToken,
          body: {
            recipient: { comment_id: comment.commentId },
            message: { text: fillTemplate(rule.dmMessage, templateContext) },
          },
        });
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
