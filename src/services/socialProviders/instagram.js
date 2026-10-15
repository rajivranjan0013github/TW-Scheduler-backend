import { createGraphClient } from './graph.js';

export const graphRequest = createGraphClient('graph.instagram.com', 'Instagram');

export const platform = 'instagram';
export const requiredScopes = ['instagram_business_manage_comments', 'instagram_business_manage_messages'];
export const webhookFields = ['comments', 'messages'];

/**
 * Webhooks identify the account by its Instagram professional account ID (`user_id`),
 * which can differ from the app-scoped `id` stored as accountId at connect time.
 */
export const resolveWebhookId = async (account) => {
  if (account.metadata?.instagramProfessionalId) return account.metadata.instagramProfessionalId;
  const data = await graphRequest('me?fields=user_id', { accessToken: account.getDecryptedAccessToken() });
  const professionalId = String(data.user_id || account.accountId);
  account.metadata = { ...(account.metadata || {}), instagramProfessionalId: professionalId };
  account.markModified('metadata');
  await account.save();
  return professionalId;
};

export const getOwnIds = (account) => (
  [account.accountId, account.metadata?.instagramProfessionalId].filter(Boolean).map(String)
);

export const accountQueryForWebhookId = (entryId) => ({
  platform,
  $or: [{ accountId: entryId }, { 'metadata.instagramProfessionalId': entryId }],
});

export const subscribe = async (account) => {
  const webhookId = await resolveWebhookId(account);
  await graphRequest(`${webhookId}/subscribed_apps?subscribed_fields=${webhookFields.join(',')}`, {
    method: 'POST',
    accessToken: account.getDecryptedAccessToken(),
  });
};

export const fetchRecentMedia = async (account, limit) => {
  const webhookId = await resolveWebhookId(account);
  const data = await graphRequest(
    `${webhookId}/media?fields=id,caption,media_type,thumbnail_url,media_url,permalink,timestamp&limit=${limit}`,
    { accessToken: account.getDecryptedAccessToken() }
  );
  return (data.data || []).map((item) => ({
    id: String(item.id),
    caption: item.caption || '',
    media_url: item.media_url || '',
    thumbnail_url: item.thumbnail_url || item.media_url || '',
    permalink: item.permalink || '',
    timestamp: item.timestamp || null,
  }));
};

const normalizeComment = (comment) => ({
  id: String(comment.id),
  text: comment.text || '',
  // `username` and `from` are withheld for commenters outside the app's roles until Advanced Access is approved
  username: comment.username || comment.from?.username || '',
  name: '',
  fromId: String(comment.from?.id || ''),
  timestamp: comment.timestamp || null,
});

export const fetchMediaComments = async (account, mediaId, limit) => {
  const data = await graphRequest(
    `${mediaId}/comments?fields=id,text,username,from{id,username},timestamp,replies{id,text,username,from{id,username},timestamp}&limit=${limit}`,
    { accessToken: account.getDecryptedAccessToken() }
  );
  return (data.data || []).map((comment) => ({
    ...normalizeComment(comment),
    replies: (comment.replies?.data || []).map(normalizeComment),
  }));
};

export const replyToComment = (account, commentId, message) => graphRequest(`${commentId}/replies`, {
  method: 'POST',
  accessToken: account.getDecryptedAccessToken(),
  body: { message },
});

export const sendPrivateReply = async (account, commentId, text) => {
  const webhookId = await resolveWebhookId(account);
  return graphRequest(`${webhookId}/messages`, {
    method: 'POST',
    accessToken: account.getDecryptedAccessToken(),
    body: { recipient: { comment_id: commentId }, message: { text } },
  });
};

export const sendMessage = async (account, recipientId, text) => {
  const webhookId = await resolveWebhookId(account);
  return graphRequest(`${webhookId}/messages`, {
    method: 'POST',
    accessToken: account.getDecryptedAccessToken(),
    body: { recipient: { id: recipientId }, message: { text } },
  });
};

export const fetchConversations = async (account) => {
  const webhookId = await resolveWebhookId(account);
  const data = await graphRequest(
    `${webhookId}/conversations?platform=instagram&limit=25&fields=participants,updated_time,messages.limit(25){id,created_time,from,to,message}`,
    { accessToken: account.getDecryptedAccessToken() }
  );
  const ownIds = new Set([...getOwnIds(account), webhookId]);
  const ownUsername = String(account.username || '').toLowerCase();
  return (data.data || []).map((thread) => {
    const participant = (thread.participants?.data || []).find((person) => (
      !ownIds.has(String(person.id)) && String(person.username || '').toLowerCase() !== ownUsername
    ));
    return participant?.id ? {
      participant: { id: String(participant.id), username: participant.username || '', name: '' },
      messages: (thread.messages?.data || []).map((message) => ({
        id: String(message.id),
        fromId: String(message.from?.id || ''),
        text: String(message.message || ''),
        createdAt: message.created_time,
      })),
    } : null;
  }).filter(Boolean);
};

export const fetchProfile = async (account, participantId) => {
  const data = await graphRequest(`${participantId}?fields=name,username,profile_pic`, {
    accessToken: account.getDecryptedAccessToken(),
  });
  return {
    participantUsername: data.username || '',
    participantName: data.name || '',
    participantAvatarUrl: data.profile_pic || '',
  };
};

/**
 * Normalizes one `comments` change from an Instagram webhook entry.
 * Returns null for changes that are not new comments.
 */
export const parseCommentChange = (entryId, change) => {
  if (change?.field !== 'comments' || !change.value?.id) return null;
  const value = change.value;
  return {
    platform,
    entryId: String(entryId),
    commentId: String(value.id),
    parentId: value.parent_id ? String(value.parent_id) : '',
    mediaId: String(value.media?.id || ''),
    text: String(value.text || ''),
    fromId: String(value.from?.id || ''),
    fromUsername: String(value.from?.username || ''),
    fromName: '',
  };
};
