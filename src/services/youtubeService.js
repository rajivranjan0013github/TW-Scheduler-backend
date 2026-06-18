import { OAuth2Client } from 'google-auth-library';

const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

const getYoutubeOAuthClient = () => {
  const clientId = process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5173/auth/youtube/callback';

  if (!clientId || !clientSecret) {
    throw new Error('YouTube OAuth credentials are not configured on the backend.');
  }

  return new OAuth2Client(clientId, clientSecret, redirectUri);
};

export const getYoutubeAuthUrl = () => {
  const client = getYoutubeOAuthClient();

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE],
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

  return {
    userId,
    platform: 'youtube',
    accountId: channel.id,
    name: snippet.title || 'YouTube Channel',
    username: snippet.customUrl || snippet.title || 'youtube_channel',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    authProvider: 'youtube',
    tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    scopes: tokens.scope ? tokens.scope.split(' ') : [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE],
    avatarUrl: thumbnail,
    metadata: {
      channelId: channel.id,
      description: snippet.description || '',
      country: snippet.country || '',
      channelUrl: `https://www.youtube.com/channel/${channel.id}`,
    },
    isConnected: true,
  };
};

const getFreshYoutubeAccessToken = async (account) => {
  if (!account.refreshToken) {
    throw new Error(`YouTube account "${account.name}" is missing a refresh token. Reconnect the channel.`);
  }

  const client = getYoutubeOAuthClient();
  client.setCredentials({ refresh_token: account.refreshToken });

  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token;

  if (!token) {
    throw new Error('Failed to refresh YouTube access token.');
  }

  return token;
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

  const accessToken = await getFreshYoutubeAccessToken(account);
  const metadata = buildYoutubeMetadata({ caption, specifics });

  console.log(`🤖 [YouTube Service] Starting upload for channel: ${account.name} (${account.accountId})`);

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

  console.log(`🎉 YouTube video uploaded successfully! ID: ${uploadData.id}`);
  return uploadData.id;
};
