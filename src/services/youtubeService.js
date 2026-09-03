import { OAuth2Client } from 'google-auth-library';
import { ensureFreshAccountToken } from './tokenHealthService.js';
import { storeRemoteSocialAccountAvatar } from './avatarStorageService.js';

const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

const getYoutubeOAuthClient = () => {
  const clientId = process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || 'https://theeasypost.com/auth/youtube/callback';

  if (!clientId || !clientSecret) {
    throw new Error('YouTube OAuth credentials are not configured on the backend.');
  }

  return new OAuth2Client(clientId, clientSecret, redirectUri);
};

export const getYoutubeAuthUrl = ({ state = '', redirectUri = null } = {}) => {
  const client = getYoutubeOAuthClient();

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE],
    ...(state ? { state } : {}),
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  });
};

export const exchangeYoutubeCodeForAccount = async (code, userId) => {
  const client = getYoutubeOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    throw new Error('Google did not return a YouTube access token.');
  }

  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Reconnect with prompt=consent and access_type=offline.');
  }

  const channelRes = await fetch('https://youtube.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });
  const channelData = await channelRes.json();

  if (!channelRes.ok) {
    throw new Error(channelData.error?.message || 'Failed to fetch YouTube channel details.');
  }

  const channel = channelData.items?.[0];
  if (!channel) {
    throw new Error('No YouTube channel was found for this Google account.');
  }

  const snippet = channel.snippet || {};
  const thumbnail =
    snippet.thumbnails?.default?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.high?.url ||
    '';
  const avatarUrl = await storeRemoteSocialAccountAvatar({
    platform: 'youtube',
    accountId: channel.id,
    avatarUrl: thumbnail,
  });

  return {
    userId,
    platform: 'youtube',
    accountId: channel.id,
    name: snippet.title || 'YouTube Channel',
    username: (snippet.customUrl || snippet.title || 'youtube_channel').replace(/^@+/, ''),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    authProvider: 'youtube',
    tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    tokenStatus: 'healthy',
    tokenRefreshError: '',
    tokenLastCheckedAt: new Date(),
    scopes: tokens.scope ? tokens.scope.split(' ') : [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE],
    avatarUrl,
    metadata: {
      channelId: channel.id,
      description: snippet.description || '',
      country: snippet.country || '',
      channelUrl: `https://www.youtube.com/channel/${channel.id}`,
    },
    isConnected: true,
  };
};

const parseTags = (tags) => {
  if (Array.isArray(tags)) return tags.filter(Boolean).map(tag => String(tag).trim()).filter(Boolean);
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
  }
  return [];
};

const buildYoutubeMetadata = ({ caption, specifics }) => {
  const youtube = specifics?.youtube || {};
  const fallbackTitle = (caption || 'Scheduled YouTube Upload').split('\n')[0].slice(0, 100);

  return {
    snippet: {
      title: youtube.title || fallbackTitle || 'Scheduled YouTube Upload',
      description: youtube.description || caption || '',
      tags: parseTags(youtube.tags),
      categoryId: youtube.categoryId || '22',
    },
    status: {
      privacyStatus: youtube.privacyStatus || 'private',
      selfDeclaredMadeForKids: Boolean(youtube.selfDeclaredMadeForKids),
    },
  };
};

export const publishToYoutube = async ({ account, media, caption, specifics }) => {
  if (!media || media.type !== 'video') {
    throw new Error('YouTube publishing requires a video media asset.');
  }

  const freshAccount = await ensureFreshAccountToken(account, { force: true });
  const accessToken = freshAccount.accessToken;
  const metadata = buildYoutubeMetadata({ caption, specifics });


  const mediaRes = await fetch(media.url);
  if (!mediaRes.ok || !mediaRes.body) {
    throw new Error(`Failed to read video media from storage: ${mediaRes.status} ${mediaRes.statusText}`);
  }

  const contentType = mediaRes.headers.get('content-type') || 'video/mp4';
  const contentLength = mediaRes.headers.get('content-length');

  const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      ...(contentLength ? { 'X-Upload-Content-Length': contentLength } : {}),
    },
    body: JSON.stringify(metadata),
  });

  if (!initRes.ok) {
    const errorData = await initRes.json().catch(() => ({}));
    throw new Error(errorData.error?.message || 'Failed to initialize YouTube upload.');
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('YouTube did not return a resumable upload URL.');
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      ...(contentLength ? { 'Content-Length': contentLength } : {}),
    },
    body: mediaRes.body,
    duplex: 'half',
  });

  const uploadData = await uploadRes.json().catch(() => ({}));

  if (!uploadRes.ok || !uploadData.id) {
    throw new Error(uploadData.error?.message || 'YouTube video upload failed.');
  }

  return uploadData.id;
};

export const fetchYoutubeVideoMetrics = async (account, videoIds = []) => {
  const uniqueVideoIds = [...new Set(videoIds.map(String).filter(Boolean))].slice(0, 50);
  if (uniqueVideoIds.length === 0) return new Map();

  const freshAccount = await ensureFreshAccountToken(account, { force: true });
  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${uniqueVideoIds.join(',')}`,
    { headers: { Authorization: `Bearer ${freshAccount.accessToken}` } }
  );
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || `YouTube statistics fetch failed (status ${response.status})`);
    error.status = response.status;
    error.retryAfterMs = Number(response.headers.get('retry-after') || 0) * 1000;
    throw error;
  }

  return new Map((payload.items || []).map((video) => [String(video.id), {
    views: Number(video.statistics?.viewCount) || 0,
    likes: Number(video.statistics?.likeCount) || 0,
    comments: Number(video.statistics?.commentCount) || 0,
    viewsSource: 'youtube_viewCount',
  }]));
};

export const fetchYoutubeVideos = async (account, { limit = 25 } = {}) => {
  const freshAccount = await ensureFreshAccountToken(account, { force: true });
  const accessToken = freshAccount.accessToken;
  const channelId = freshAccount.accountId;
  const uploadsPlaylistId = channelId.replace(/^UC/, 'UU');


  // 1. Fetch playlist items
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 25));
  const playlistItemsUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${safeLimit}`;
  const playlistRes = await fetch(playlistItemsUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const playlistData = await playlistRes.json();
  if (!playlistRes.ok) {
    const error = new Error(playlistData.error?.message || `YouTube playlist items fetch failed (status ${playlistRes.status})`);
    error.status = playlistRes.status;
    error.retryAfterMs = Number(playlistRes.headers.get('retry-after') || 0) * 1000;
    throw error;
  }

  const items = playlistData.items || [];
  if (items.length === 0) {
    return [];
  }

  const videoIds = items.map(item => item.contentDetails?.videoId).filter(Boolean);
  if (videoIds.length === 0) {
    return [];
  }

  // 2. Fetch video details & statistics
  const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,status&id=${videoIds.join(',')}`;
  const videosRes = await fetch(videosUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const videosData = await videosRes.json();
  if (!videosRes.ok) {
    const error = new Error(videosData.error?.message || `YouTube video details fetch failed (status ${videosRes.status})`);
    error.status = videosRes.status;
    error.retryAfterMs = Number(videosRes.headers.get('retry-after') || 0) * 1000;
    throw error;
  }

  return (videosData.items || []).map(video => {
    const snippet = video.snippet || {};
    const stats = video.statistics || {};
    const thumbnails = snippet.thumbnails || {};
    const mediaUrl = thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || '';

    return {
      // For API route mapping in accounts.js
      id: video.id,
      createdAt: snippet.publishedAt,
      views: Number(stats.viewCount) || 0,
      likes: Number(stats.likeCount) || 0,
      comments: Number(stats.commentCount) || 0,

      // For feedSyncWorker.js DB upsert
      metaPostId: video.id,
      platform: 'youtube',
      publishedAt: new Date(snippet.publishedAt),
      latestViews: Number(stats.viewCount) || 0,
      latestLikes: Number(stats.likeCount) || 0,
      latestComments: Number(stats.commentCount) || 0,

      // Shared fields
      content: snippet.title || '',
      mediaUrl,
      videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
      mediaType: 'VIDEO',
      permalink: `https://www.youtube.com/watch?v=${video.id}`,
    };
  });
};
