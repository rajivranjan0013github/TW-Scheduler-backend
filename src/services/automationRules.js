import {
  hasAutomationScopes,
  hasCurrentWebhookSubscription,
  supportsDm,
} from './socialProviders/index.js';

// Rule validation and serialization shared by the handler routes (/api/automations)
// and the admin routes (/api/admin/automations), so both enforce the same limits.

export const MAX_KEYWORDS = 30;
export const MAX_REPLIES = 10;
export const MAX_MEDIA_IDS = 100;

/**
 * Meta / YouTube rejected the call. Answered with 424 rather than 502: proxies like nginx and
 * Cloudflare replace 502 bodies with their own error page, which hides the provider's reason.
 */
export const sendProviderError = (res, req, error) => {
  console.error(`[Automations] ${req.method} ${req.path} failed:`, error.message, error.data?.error || '');
  res.status(error.statusCode && error.statusCode < 500 ? error.statusCode : 424).json({ message: error.message });
};

const cleanStringList = (value, { max, maxLength }) => (
  Array.isArray(value) ? value : []
)
  .map((item) => String(item ?? '').trim().slice(0, maxLength))
  .filter(Boolean)
  .filter((item, index, list) => list.indexOf(item) === index)
  .slice(0, max);

// YouTube has no DMs, so rules there can only reply publicly
export const buildRulePayload = (body = {}, platform = 'instagram') => {
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

/**
 * Applies a PATCH body to a rule document: `{ enabled }` alone just pauses or resumes it,
 * anything else is a full edit validated like a new rule. Returns `{ error }` on bad input.
 */
export const applyRuleUpdate = (rule, body = {}, updatedBy = null) => {
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === 'enabled') {
    rule.enabled = Boolean(body.enabled);
  } else {
    const { payload, error } = buildRulePayload({ ...rule.toObject(), ...body }, rule.platform);
    if (error) return { error };
    rule.set(payload);
  }
  if (updatedBy) rule.updatedBy = updatedBy;
  return {};
};

export const serializeAccount = (account) => ({
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
