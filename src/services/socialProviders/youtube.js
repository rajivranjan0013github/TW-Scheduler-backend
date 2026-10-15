const API_BASE = 'https://www.googleapis.com/youtube/v3';

export const platform = 'youtube';
// Reading and posting comments needs force-ssl; the upload/readonly scopes used for publishing are not enough
export const COMMENT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
export const requiredScopes = [COMMENT_SCOPE];
// YouTube has no comment webhooks: new comments are found by polling (see youtubeCommentPoller)
export const webhookFields = [];
// YouTube has no private messaging API
export const supportsDm = false;

// Video IDs are 11 URL-safe characters; comment IDs are longer and replies contain a "."
export const isValidObjectId = (value) => /^[A-Za-z0-9_.-]{1,128}$/.test(String(value || ''));

const youtubeRequest = async (path, { method = 'GET', accessToken, body } = {}) => {
  const response = await fetch(`${API_BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `YouTube request failed with status ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
};

export const resolveWebhookId = async (account) => String(account.accountId);

export const getOwnIds = (account) => [String(account.accountId)];

export const accountQueryForWebhookId = (channelId) => ({ platform, accountId: channelId });

// Nothing to subscribe to; the poller picks the channel up once it has the comment scope
export const subscribe = async () => {};

export const fetchRecentMedia = async (account, limit) => {
  const uploadsPlaylistId = String(account.accountId).replace(/^UC/, 'UU');
  const data = await youtubeRequest(
    `playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=${Math.min(50, limit)}`,
    { accessToken: account.getDecryptedAccessToken() }
  );
  return (data.items || []).map((item) => {
    const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    const thumbnails = item.snippet?.thumbnails || {};
    const thumbnail = thumbnails.medium?.url || thumbnails.high?.url || thumbnails.default?.url || '';
    return {
      id: String(videoId),
      caption: item.snippet?.title || '',
      media_url: thumbnail,
      thumbnail_url: thumbnail,
      permalink: `https://www.youtube.com/watch?v=${videoId}`,
      timestamp: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
    };
  }).filter((item) => item.id && item.id !== 'undefined');
};

const normalizeComment = (comment) => {
  const snippet = comment?.snippet || {};
  return {
    id: String(comment.id),
    text: snippet.textOriginal || snippet.textDisplay || '',
    // YouTube display names are the channel handle, e.g. "@sam"
    username: String(snippet.authorDisplayName || '').replace(/^@/, ''),
    name: '',
    fromId: String(snippet.authorChannelId?.value || ''),
    timestamp: snippet.publishedAt || null,
  };
};

const normalizeThread = (thread) => ({
  ...normalizeComment(thread.snippet?.topLevelComment || {}),
  mediaId: String(thread.snippet?.videoId || ''),
  replies: (thread.replies?.comments || []).map(normalizeComment),
});

export const fetchMediaComments = async (account, videoId, limit) => {
  const data = await youtubeRequest(
    `commentThreads?part=snippet,replies&videoId=${encodeURIComponent(videoId)}&order=time&textFormat=plainText&maxResults=${Math.min(100, limit)}`,
    { accessToken: account.getDecryptedAccessToken() }
  );
  return (data.items || []).map(normalizeThread);
};

/**
 * Newest comment threads across every video on the channel in one call (1 quota unit).
 * Used by the poller in place of webhooks.
 */
export const fetchChannelComments = async (account, limit = 50) => {
  const data = await youtubeRequest(
    `commentThreads?part=snippet,replies&allThreadsRelatedToChannelId=${encodeURIComponent(account.accountId)}&order=time&textFormat=plainText&maxResults=${Math.min(100, limit)}`,
    { accessToken: account.getDecryptedAccessToken() }
  );
  return (data.items || []).map(normalizeThread);
};

// Threads are one level deep: replying to a reply ("parent.child" ID) answers the top-level comment
export const replyToComment = (account, commentId, message) => youtubeRequest('comments?part=snippet', {
  method: 'POST',
  accessToken: account.getDecryptedAccessToken(),
  body: { snippet: { parentId: String(commentId).split('.')[0], textOriginal: message } },
});

const unsupported = async () => {
  const error = new Error('YouTube does not support direct messages.');
  error.statusCode = 400;
  throw error;
};

export const sendPrivateReply = unsupported;
export const sendMessage = unsupported;
export const fetchConversations = async () => [];
export const fetchProfile = async () => ({});
export const parseCommentChange = () => null;
