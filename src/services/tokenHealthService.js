import { OAuth2Client } from 'google-auth-library';
import SocialAccount from '../models/SocialAccount.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 14 * DAY_MS;

const getYoutubeOAuthClient = () => {
  const clientId = process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5173/auth/youtube/callback';

  if (!clientId || !clientSecret) {
    throw new Error('YouTube OAuth credentials are not configured on the backend.');
  }

  return new OAuth2Client(clientId, clientSecret, redirectUri);
};

const getExpiryStatus = (expiresAt) => {
  if (!expiresAt) return 'healthy';

  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return 'unknown';
  if (expiresMs <= Date.now()) return 'expired';
  if (expiresMs - Date.now() <= REFRESH_WINDOW_MS) return 'expiring';
  return 'healthy';
};

export const isProviderAuthError = (error = {}) => {
  const code = Number(error.code || error.error?.code || 0);
  const status = Number(error.status || error.statusCode || 0);
  const type = String(error.type || error.error?.type || '').toLowerCase();
  const message = String(error.message || error.error?.message || '').toLowerCase();

  return (
    status === 401 ||
    code === 190 ||
    code === 102 ||
    code === 401 ||
    type.includes('oauthexception') ||
    message.includes('access token') ||
    message.includes('invalid token') ||
    message.includes('expired token') ||
    message.includes('refresh token') ||
    message.includes('token has expired')
  );
};

export const markAccountReauthRequired = async (account, reason = 'Reauthorization required.') => {
  if (!account?._id) return null;

  const updates = {
    isConnected: false,
    tokenStatus: 'reauth_required',
    tokenRefreshError: reason,
    tokenLastCheckedAt: new Date(),
  };

  if (typeof account.set === 'function') {
    account.set(updates);
    await account.save();
    return account;
  }

  return SocialAccount.findByIdAndUpdate(account._id, updates, { returnDocument: 'after' });
};

const markAccountHealthy = async (account, updates = {}) => {
  if (!account?._id) return account;

  const payload = {
    ...updates,
    isConnected: true,
    tokenStatus: getExpiryStatus(updates.tokenExpiresAt || account.tokenExpiresAt),
    tokenRefreshError: '',
    tokenLastCheckedAt: new Date(),
  };

  if (typeof account.set === 'function') {
    account.set(payload);
    await account.save();
    return account;
  }

  return SocialAccount.findByIdAndUpdate(account._id, payload, { returnDocument: 'after' });
};

const refreshDirectInstagramToken = async (account) => {
  const refreshUrl = `https://graph.instagram.com/refresh_access_token` +
    `?grant_type=ig_refresh_token` +
    `&access_token=${encodeURIComponent(account.accessToken)}`;

  const response = await fetch(refreshUrl);
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    const error = data.error || data;
    throw new Error(error.message || 'Instagram token refresh failed.');
  }

  const tokenExpiresAt = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000)
    : account.tokenExpiresAt;

  return markAccountHealthy(account, {
    accessToken: data.access_token,
    tokenExpiresAt,
  });
};

const refreshYoutubeToken = async (account) => {
  if (!account.refreshToken) {
    throw new Error(`YouTube account "${account.name}" is missing a refresh token.`);
  }

  const client = getYoutubeOAuthClient();
  client.setCredentials({ refresh_token: account.refreshToken });

  const { credentials } = await client.refreshAccessToken();
  if (!credentials?.access_token) {
    throw new Error('Failed to refresh YouTube access token.');
  }

  return markAccountHealthy(account, {
    accessToken: credentials.access_token,
    tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : account.tokenExpiresAt,
  });
};

export const ensureFreshAccountToken = async (account, { force = false } = {}) => {
  if (!account || account.accessToken?.startsWith('mock-')) return account;
  if (account.isConnected === false) {
    throw new Error(`Account "${account.name}" requires reauthorization.`);
  }

  const status = getExpiryStatus(account.tokenExpiresAt);

  try {
    if (account.platform === 'youtube') {
      if (force || status !== 'healthy') return refreshYoutubeToken(account);
      return markAccountHealthy(account);
    }

    if (account.platform === 'instagram' && account.authProvider === 'instagram') {
      if (force || status !== 'healthy') return refreshDirectInstagramToken(account);
      return markAccountHealthy(account);
    }

    return markAccountHealthy(account);
  } catch (error) {
    const hasExpired = status === 'expired';
    if (hasExpired || isProviderAuthError(error)) {
      await markAccountReauthRequired(account, error.message);
    } else if (typeof account.set === 'function') {
      account.set({
        tokenStatus: status,
        tokenRefreshError: error.message,
        tokenLastCheckedAt: new Date(),
      });
      await account.save();
    }
    throw error;
  }
};

export const handleProviderAuthFailure = async (account, errorData, fallbackMessage = 'Provider authorization failed.') => {
  const message = errorData?.error?.message || errorData?.message || fallbackMessage;
  if (isProviderAuthError(errorData)) {
    await markAccountReauthRequired(account, message);
  }
};

export const runTokenHealthCheck = async () => {
  const accounts = await SocialAccount.find({
    isConnected: true,
    accessToken: { $not: /^mock-/ },
  });

  const result = {
    checked: 0,
    refreshed: 0,
    reauthRequired: 0,
    failed: 0,
  };

  for (const account of accounts) {
    try {
      const beforeToken = account.accessToken;
      const beforeExpiry = account.tokenExpiresAt?.getTime?.() || null;
      const freshAccount = await ensureFreshAccountToken(account);
      const afterExpiry = freshAccount.tokenExpiresAt?.getTime?.() || null;

      result.checked += 1;
      if (freshAccount.accessToken !== beforeToken || afterExpiry !== beforeExpiry) {
        result.refreshed += 1;
      }
    } catch (error) {
      result.failed += 1;
      const latest = await SocialAccount.findById(account._id).select('tokenStatus').lean();
      if (latest?.tokenStatus === 'reauth_required') {
        result.reauthRequired += 1;
      }
      console.error(`❌ [Token Health] ${account.platform} account "${account.name}" failed:`, error.message);
    }
  }

  return result;
};
