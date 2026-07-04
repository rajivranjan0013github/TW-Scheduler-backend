import path from 'path';
import { uploadFile, getStorageUrl } from './r2Service.js';
import { getSocialAccountAvatarStorageKey, getUserAvatarStorageKey } from '../utils/storageKeys.js';

const getConfiguredPublicBaseUrl = () => (
  process.env.R2_PUBLIC_URL || 'https://media.theeasypost.com'
).trim().replace(/\/$/, '');

const isStoredAvatarUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  const publicBaseUrl = getConfiguredPublicBaseUrl();
  const backendUrl = (process.env.BACKEND_URL || 'https://theeasypost.com').trim().replace(/\/$/, '');

  return (
    url.startsWith(`${publicBaseUrl}/users/`) ||
    url.startsWith(`${publicBaseUrl}/social-accounts/`) ||
    url.startsWith(`${backendUrl}/uploads/users/`) ||
    url.startsWith(`${backendUrl}/uploads/social-accounts/`)
  );
};

const getExtensionFromContentType = (contentType) => {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  return '.jpg';
};

const getExtensionFromUrl = (url) => {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension)) {
      return extension === '.jpeg' ? '.jpg' : extension;
    }
  } catch {
    return '';
  }
  return '';
};

export const shouldStoreAvatarUrl = (url) => Boolean(url && !isStoredAvatarUrl(url));

export const storeRemoteAvatar = async ({ userId, avatarUrl, storageKey }) => {
  if ((!userId && !storageKey) || !shouldStoreAvatarUrl(avatarUrl)) {
    return avatarUrl || '';
  }

  const response = await fetch(avatarUrl);
  if (!response.ok) {
    throw new Error(`Avatar fetch failed with status ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Avatar URL returned non-image content type: ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const extension = getExtensionFromUrl(avatarUrl) || getExtensionFromContentType(contentType);
  const targetStorageKey = storageKey || getUserAvatarStorageKey({ userId, extension });
  const uploaded = await uploadFile({
    buffer,
    originalname: `avatar${extension}`,
    mimetype: contentType,
    storageKey: targetStorageKey,
  });

  return uploaded.url || getStorageUrl(targetStorageKey);
};

export const storeRemoteSocialAccountAvatar = async ({ platform, accountId, avatarUrl }) => {
  if (!platform || !accountId || !shouldStoreAvatarUrl(avatarUrl)) {
    return avatarUrl || '';
  }

  try {
    const extension = getExtensionFromUrl(avatarUrl) || '.jpg';
    return await storeRemoteAvatar({
      avatarUrl,
      storageKey: getSocialAccountAvatarStorageKey({ platform, accountId, extension }),
    });
  } catch (error) {
    console.error(`Avatar storage failed for ${platform} account ${accountId}:`, error.message);
    return avatarUrl || '';
  }
};

export const storeRemoteAvatarForUser = async (user, avatarUrl) => {
  if (user?.avatar && !shouldStoreAvatarUrl(user.avatar)) {
    return user.avatar;
  }

  if (!user?._id || !shouldStoreAvatarUrl(avatarUrl)) {
    return user?.avatar || avatarUrl || '';
  }

  try {
    const storedAvatarUrl = await storeRemoteAvatar({
      userId: user._id,
      avatarUrl,
    });

    if (storedAvatarUrl && storedAvatarUrl !== user.avatar) {
      user.avatar = storedAvatarUrl;
      await user.save();
    }

    return storedAvatarUrl;
  } catch (error) {
    console.error(`Avatar storage failed for user ${user._id}:`, error.message);
    return user.avatar || avatarUrl || '';
  }
};
