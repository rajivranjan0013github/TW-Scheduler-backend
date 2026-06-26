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

const readErrorBody = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

const getErrorMessage = (error = {}, fallbackMessage = 'Token refresh failed.') => {
  return (
    error.error?.message ||
    error.response?.data?.error_description ||
    error.response?.data?.error?.message ||
    error.response?.data?.error ||
    error.message ||
    fallbackMessage
  );
};

const throwProviderError = (message, { status, error, data } = {}) => {
  const providerError = new Error(message);
  providerError.status = status;
  providerError.error = error;
  providerError.providerData = data;
  throw providerError;
};

export const isProviderAuthError = (error = {}) => {
  const responseData = error.response?.data || {};
  const responseError = responseData.error || {};
  const code = Number(error.code || error.error?.code || responseError.code || 0);
  const status = Number(error.status || error.statusCode || error.response?.status || 0);
  const type = String(error.type || error.error?.type || responseError.type || '').toLowerCase();
  const providerErrorName = String(
    typeof responseError === 'string' ? responseError : responseData.error_code || ''
  ).toLowerCase();
  const message = String(
    error.message ||
    error.error?.message ||
    responseError.message ||
    responseData.error_description ||
    ''
  ).toLowerCase();

  return (
    status === 401 ||
    code === 190 ||
    code === 102 ||
    code === 401 ||
    providerErrorName === 'invalid_grant' ||
    providerErrorName === 'invalid_token' ||
    (type.includes('oauthexception') && message.includes('error validating access token')) ||
    message.includes('invalid oauth access token') ||
    message.includes('error validating access token') ||
    message.includes('access token has expired') ||
    message.includes('token has expired') ||
    message.includes('session has expired') ||
    message.includes('refresh token is invalid') ||
    message.includes('refresh token has expired') ||
    message.includes('refresh token has been revoked') ||
    message.includes('invalid_grant')
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

const markAccountRefreshFailed = async (account, error, status) => {
  if (!account?._id) return account;

  const payload = {
    tokenStatus: status,
    tokenRefreshError: getErrorMessage(error),
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
  const data = await readErrorBody(response);

  if (!response.ok || !data.access_token) {
    const error = data.error || data;
    throwProviderError(error.message || 'Instagram token refresh failed.', {
      status: response.status,
      error,
      data,
    });
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
    if (isProviderAuthError(error)) {
      await markAccountReauthRequired(account, getErrorMessage(error));
    } else {
      await markAccountRefreshFailed(account, error, status);
    }
    throw error;
  }
};

export const handleProviderAuthFailure = async (account, errorData, fallbackMessage = 'Provider authorization failed.') => {
  const message = getErrorMessage(errorData, fallbackMessage);
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
