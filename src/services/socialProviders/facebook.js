import { createGraphClient } from './graph.js';

export const graphRequest = createGraphClient('graph.facebook.com', 'Facebook');

export const platform = 'facebook';
export const requiredScopes = [
  'pages_manage_metadata',
  'pages_manage_engagement',
  'pages_read_user_content',
  'pages_messaging',
];
export const webhookFields = ['feed', 'messages'];

// A Facebook Page account stores the Page ID as accountId and a Page access token
export const resolveWebhookId = async (account) => String(account.accountId);

export const getOwnIds = (account) => [String(account.accountId)];

export const accountQueryForWebhookId = (entryId) => ({ platform, accountId: entryId });

export const subscribe = async (account) => {
  await graphRequest(`${account.accountId}/subscribed_apps?subscribed_fields=${webhookFields.join(',')}`, {
    method: 'POST',
    accessToken: account.getDecryptedAccessToken(),
  });
};

export const fetchRecentMedia = async (account, limit) => {
  const data = await graphRequest(
    `${account.accountId}/posts?fields=id,message,full_picture,permalink_url,created_time&limit=${limit}`,
    { accessToken: account.getDecryptedAccessToken() }
  );
  return (data.data || []).map((post) => ({
    id: String(post.id),
    caption: post.message || '',
    media_url: post.full_picture || '',
    thumbnail_url: post.full_picture || '',
    permalink: post.permalink_url || '',
    timestamp: post.created_time || null,
  }));
};

const normalizeComment = (comment) => ({
  id: String(comment.id),
  text: comment.message || '',
  username: '',
  // `from` needs pages_read_user_content; Facebook has no public handles, so the display name is used
  name: comment.from?.name || '',
  fromId: String(comment.from?.id || ''),
  timestamp: comment.created_time || null,
});

export const fetchMediaComments = async (account, postId, limit) => {
  const data = await graphRequest(
    `${postId}/comments?filter=toplevel&order=reverse_chronological&limit=${limit}`
      + '&fields=id,message,from{id,name},created_time,comments.limit(25){id,message,from{id,name},created_time}',
    { accessToken: account.getDecryptedAccessToken() }
  );
  return (data.data || []).map((comment) => ({
    ...normalizeComment(comment),
    replies: (comment.comments?.data || []).map(normalizeComment),
  }));
};

export const replyToComment = (account, commentId, message) => graphRequest(`${commentId}/comments`, {
  method: 'POST',
  accessToken: account.getDecryptedAccessToken(),
  body: { message },
});

export const sendPrivateReply = (account, commentId, text) => graphRequest(`${account.accountId}/messages`, {
  method: 'POST',
  accessToken: account.getDecryptedAccessToken(),
  body: { recipient: { comment_id: commentId }, message: { text } },
});

export const sendMessage = (account, recipientId, text) => graphRequest(`${account.accountId}/messages`, {
  method: 'POST',
  accessToken: account.getDecryptedAccessToken(),
  body: { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } },
});

export const fetchConversations = async (account) => {
  const data = await graphRequest(
    `${account.accountId}/conversations?platform=messenger&limit=25&fields=participants,updated_time,messages.limit(25){id,created_time,from,to,message}`,
    { accessToken: account.getDecryptedAccessToken() }
  );
  const pageId = String(account.accountId);
  return (data.data || []).map((thread) => {
    const participant = (thread.participants?.data || []).find((person) => String(person.id) !== pageId);
    return participant?.id ? {
      participant: { id: String(participant.id), username: '', name: participant.name || '' },
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
  const data = await graphRequest(`${participantId}?fields=first_name,last_name,profile_pic`, {
    accessToken: account.getDecryptedAccessToken(),
  });
  return {
    participantUsername: '',
    participantName: [data.first_name, data.last_name].filter(Boolean).join(' '),
    participantAvatarUrl: data.profile_pic || '',
  };
};

/**
 * Normalizes one `feed` change from a Page webhook entry.
 * Only newly added comments are returned; posts, likes, edits and deletes are ignored.
 */
export const parseCommentChange = (entryId, change) => {
  const value = change?.value;
  if (change?.field !== 'feed' || value?.item !== 'comment' || value.verb !== 'add' || !value.comment_id) return null;
  const postId = String(value.post_id || '');
  const parentId = value.parent_id ? String(value.parent_id) : '';
  return {
    platform,
    entryId: String(entryId),
    commentId: String(value.comment_id),
    // Top-level comments report the post itself as their parent
    parentId: parentId && parentId !== postId ? parentId : '',
    mediaId: postId,
    text: String(value.message || ''),
    fromId: String(value.from?.id || ''),
    fromUsername: '',
    fromName: String(value.from?.name || ''),
  };
};
