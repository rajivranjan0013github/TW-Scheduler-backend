import SocialAccount from '../../models/SocialAccount.js';
import { ensureFreshAccountToken, handleProviderAuthFailure } from '../tokenHealthService.js';
import * as instagram from './instagram.js';
import * as facebook from './facebook.js';
import * as youtube from './youtube.js';
import { hasAccountPolicyConsent, requireAccountPolicyConsent } from '../policyConsentService.js';

const providers = { instagram, facebook, youtube };

export const AUTOMATION_PLATFORMS = Object.keys(providers);

export const getProvider = (platform) => {
  const provider = providers[platform];
  if (!provider) throw new Error(`Automations are not supported for ${platform}.`);
  return provider;
};

// Webhook objects: Instagram Login sends `instagram`, Facebook Pages send `page`
export const getProviderForWebhookObject = (object) => (
  object === 'instagram' ? instagram : object === 'page' ? facebook : null
);

export const findAccountsForEntry = async (platform, entryId) => {
  const accounts = await SocialAccount.find({
    isConnected: true,
    ...getProvider(platform).accountQueryForWebhookId(String(entryId)),
  });
  const consent = await Promise.all(accounts.map(hasAccountPolicyConsent));
  return accounts.filter((_account, index) => consent[index]);
};

export const getOwnIds = (account) => getProvider(account.platform).getOwnIds(account);

export const hasAutomationScopes = (account) => {
  const provider = providers[account?.platform];
  const scopes = Array.isArray(account?.scopes) ? account.scopes : [];
  return Boolean(provider) && provider.requiredScopes.every((scope) => scopes.includes(scope));
};

// Platforms without webhooks (YouTube) are always "subscribed": their comments are polled
export const hasCurrentWebhookSubscription = (account) => {
  const provider = providers[account?.platform];
  if (provider && provider.webhookFields.length === 0) return true;
  const fields = account?.metadata?.automationSubscribedFields || [];
  return Boolean(provider && account.metadata?.automationSubscribedAt)
    && provider.webhookFields.every((field) => fields.includes(field));
};

// Graph object IDs are numeric (Facebook post and comment IDs are two numbers joined by "_")
export const isGraphObjectId = (value) => /^\d{1,32}(_\d{1,32})?$/.test(String(value || ''));

// Rejecting anything else keeps user input from reaching other API paths
export const isValidObjectId = (platform, value) => (
  providers[platform]?.isValidObjectId ? providers[platform].isValidObjectId(value) : isGraphObjectId(value)
);

export const supportsDm = (platform) => providers[platform]?.supportsDm !== false;

/**
 * Runs a provider call with a fresh token, flagging the account for reauthorization
 * when Meta rejects the token.
 */
export const withAccount = async (account, call) => {
  await requireAccountPolicyConsent(account);
  const freshAccount = await ensureFreshAccountToken(account);
  try {
    return await call(getProvider(freshAccount.platform), freshAccount);
  } catch (error) {
    await handleProviderAuthFailure(freshAccount, error.data, error.message);
    throw error;
  }
};

export const subscribeAccountToWebhooks = (account) => withAccount(account, async (provider, freshAccount) => {
  await provider.subscribe(freshAccount);
  freshAccount.metadata = {
    ...(freshAccount.metadata || {}),
    automationSubscribedAt: new Date().toISOString(),
    automationSubscribedFields: provider.webhookFields,
    automationSubscribeError: '',
  };
  freshAccount.markModified('metadata');
  await freshAccount.save();
  return freshAccount;
});

export const fetchRecentMedia = (account, limit = 24) => (
  withAccount(account, (provider, freshAccount) => provider.fetchRecentMedia(freshAccount, limit))
);

export const fetchMediaComments = (account, mediaId, limit = 50) => withAccount(account, async (provider, freshAccount) => (
  (await provider.fetchMediaComments(freshAccount, mediaId, limit)).map((comment) => ({
    ...comment,
    replies: [...comment.replies].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
  }))
));

export const replyToComment = (account, commentId, message) => (
  withAccount(account, (provider, freshAccount) => provider.replyToComment(freshAccount, commentId, message))
);

export const sendPrivateReply = (account, commentId, text) => (
  withAccount(account, (provider, freshAccount) => provider.sendPrivateReply(freshAccount, commentId, text))
);
