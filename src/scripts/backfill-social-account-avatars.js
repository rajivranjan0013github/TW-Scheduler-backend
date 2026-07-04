import 'dotenv/config';
import mongoose from 'mongoose';
import SocialAccount from '../models/SocialAccount.js';
import { shouldStoreAvatarUrl, storeRemoteSocialAccountAvatar } from '../services/avatarStorageService.js';

const platformArg = process.argv.find((arg) => arg.startsWith('--platform='));
const platform = platformArg?.split('=')[1] || 'youtube';

const fetchJson = async (url) => {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Request failed with status ${response.status}`);
  }
  return data;
};

const fetchFreshAvatarUrl = async (account) => {
  if (!account.accessToken) return '';

  if (account.platform === 'facebook') {
    return `https://graph.facebook.com/v20.0/${account.accountId}/picture?type=normal&access_token=${encodeURIComponent(account.accessToken)}`;
  }

  if (account.platform === 'instagram') {
    const graphHost = account.authProvider === 'instagram'
      ? 'graph.instagram.com'
      : 'graph.facebook.com';
    const accountPath = account.authProvider === 'instagram'
      ? 'me'
      : account.accountId;
    const data = await fetchJson(
      `https://${graphHost}/v20.0/${accountPath}?fields=profile_picture_url&access_token=${encodeURIComponent(account.accessToken)}`
    );
    return data.profile_picture_url || '';
  }

  return '';
};

const connect = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
};

const main = async () => {
  await connect();

  const accounts = await SocialAccount.find({ platform })
    .select('_id platform accountId name username avatarUrl accessToken authProvider')
    .sort({ name: 1 });

  const candidates = accounts.filter((account) => shouldStoreAvatarUrl(account.avatarUrl));
  const results = [];

  for (const account of candidates) {
    const before = account.avatarUrl || '';
    let source = 'cached';
    let after = await storeRemoteSocialAccountAvatar({
      platform: account.platform,
      accountId: account.accountId || account._id,
      avatarUrl: before,
    });

    if (!after || after === before) {
      try {
        const freshAvatarUrl = await fetchFreshAvatarUrl(account);
        if (freshAvatarUrl && freshAvatarUrl !== before) {
          source = 'refreshed';
          after = await storeRemoteSocialAccountAvatar({
            platform: account.platform,
            accountId: account.accountId || account._id,
            avatarUrl: freshAvatarUrl,
          });
        }
      } catch (error) {
        console.error(`Fresh avatar fetch failed for ${account.platform} account ${account.accountId}:`, error.message);
      }
    }

    if (after && after !== before) {
      account.avatarUrl = after;
      await account.save();
    }

    results.push({
      id: account._id.toString(),
      name: account.name,
      username: account.username,
      platform: account.platform,
      changed: Boolean(after && after !== before),
      source,
      before,
      after,
    });
  }

};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
