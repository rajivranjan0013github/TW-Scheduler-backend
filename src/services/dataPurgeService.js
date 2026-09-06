import BulkAgentPlan from '../models/BulkAgentPlan.js';
import BulkMediaReservation from '../models/BulkMediaReservation.js';
import Campaign from '../models/Campaign.js';
import CampaignChannel from '../models/CampaignChannel.js';
import Folder from '../models/Folder.js';
import Insight from '../models/Insight.js';
import Media from '../models/Media.js';
import MetricSyncStatus from '../models/MetricSyncStatus.js';
import OAuthStateNonce from '../models/OAuthStateNonce.js';
import PostInsight from '../models/PostInsight.js';
import PostMetricDailySnapshot from '../models/PostMetricDailySnapshot.js';
import PostMetricSnapshot from '../models/PostMetricSnapshot.js';
import PublishedPost from '../models/PublishedPost.js';
import SavedCaption from '../models/SavedCaption.js';
import ScheduledPost from '../models/ScheduledPost.js';
import SocialAccount from '../models/SocialAccount.js';
import User from '../models/User.js';
import { deleteFile, getStorageKeyFromUrl } from './r2Service.js';
import { revokeMetaPermissions } from './metaService.js';
import { revokeYoutubeToken } from './youtubeService.js';

const uniqueStrings = (values = []) => [...new Set(values.map(String).filter(Boolean))];
const anyOf = (clauses) => (clauses.length ? { $or: clauses } : { _id: null });

const revokeAccount = async (account) => {
  if (!account) return;
  if (account.platform === 'youtube') {
    await revokeYoutubeToken(account);
    return;
  }
  if (account.platform === 'facebook' || account.platform === 'instagram') {
    await revokeMetaPermissions(account.accessToken, { authProvider: account.authProvider });
  }
};

const removeStoredObjects = async ({ media = [], accounts = [], user = null, additionalUrls = [] } = {}) => {
  const storageKeys = uniqueStrings([
    ...media.flatMap((item) => [item.storageKey, item.thumbnailStorageKey]),
    ...accounts.map((account) => getStorageKeyFromUrl(account.avatarUrl)),
    getStorageKeyFromUrl(user?.avatar),
    ...additionalUrls.map(getStorageKeyFromUrl),
  ]);

  const results = await Promise.allSettled(storageKeys.map((storageKey) => deleteFile(storageKey)));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`Could not erase ${failures.length} stored media object(s). Please retry the deletion request.`);
  }
};

const revokeAccounts = async (accounts, enabled) => {
  if (!enabled) return [];
  const results = await Promise.allSettled(accounts.map(revokeAccount));
  const failures = results
    .map((result, index) => ({ result, account: accounts[index] }))
    .filter(({ result }) => result.status === 'rejected');
  failures.forEach(({ result, account }) => {
    console.warn('[Data purge] Provider revocation failed; local data will still be erased.', {
      accountId: String(account?._id || ''),
      platform: account?.platform || '',
      message: result.reason?.message || 'Unknown revocation error',
    });
  });
  return failures;
};

export const purgeSocialAccounts = async (accountIds = [], { revokeProviderAccess = true } = {}) => {
  const ids = uniqueStrings(accountIds);
  if (ids.length === 0) return { accountsDeleted: 0, revocationFailures: 0 };

  const accounts = await SocialAccount.find({ _id: { $in: ids } });
  const persistedIds = accounts.map((account) => account._id);
  if (persistedIds.length === 0) return { accountsDeleted: 0, revocationFailures: 0 };

  const channelIds = await CampaignChannel.find({
    socialAccountId: { $in: persistedIds },
  }).distinct('_id');
  const revocationFailures = await revokeAccounts(accounts, revokeProviderAccess);
  await removeStoredObjects({ accounts });

  await Promise.all([
    ScheduledPost.deleteMany({
      $or: [
        { socialAccountIds: { $in: persistedIds } },
        ...(channelIds.length ? [{ campaignChannelIds: { $in: channelIds } }] : []),
      ],
    }),
    PublishedPost.deleteMany({ accountId: { $in: persistedIds } }),
    PostMetricSnapshot.deleteMany({ accountId: { $in: persistedIds } }),
    PostMetricDailySnapshot.deleteMany({ accountId: { $in: persistedIds } }),
    PostInsight.deleteMany({ accountId: { $in: persistedIds } }),
    Insight.deleteMany({ accountId: { $in: persistedIds } }),
    MetricSyncStatus.deleteMany({ accountId: { $in: persistedIds } }),
    CampaignChannel.deleteMany({ socialAccountId: { $in: persistedIds } }),
    Campaign.updateMany(
      { $or: [{ accountIds: { $in: persistedIds } }, { 'channels.socialAccountId': { $in: persistedIds } }] },
      {
        $pull: {
          accountIds: { $in: persistedIds },
          channels: { socialAccountId: { $in: persistedIds } },
        },
      },
    ),
    Media.updateMany(
      { socialAccountIds: { $in: persistedIds } },
      { $pull: { socialAccountIds: { $in: persistedIds } } },
    ),
    SocialAccount.deleteMany({ _id: { $in: persistedIds } }),
  ]);

  return {
    accountsDeleted: persistedIds.length,
    revocationFailures: revocationFailures.length,
  };
};

export const purgeUserData = async (userId, { revokeProviderAccess = true } = {}) => {
  const user = await User.findById(userId);
  if (!user) return { userDeleted: false, accountsDeleted: 0 };

  const [accounts, ownedCampaigns] = await Promise.all([
    SocialAccount.find({ userId }),
    Campaign.find({ createdBy: userId }).select('_id iconUrl screenshots').lean(),
  ]);
  const accountIds = accounts.map((account) => account._id);
  const ownedCampaignIds = ownedCampaigns.map((campaign) => campaign._id);
  const media = await Media.find({
    $or: [
      { userId },
      ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
    ],
  }).select('storageKey thumbnailStorageKey');

  const revocationFailures = await revokeAccounts(accounts, revokeProviderAccess);
  await removeStoredObjects({
    media,
    accounts,
    user,
    additionalUrls: ownedCampaigns.flatMap((campaign) => [campaign.iconUrl, ...(campaign.screenshots || [])]),
  });

  await Promise.all([
    ScheduledPost.deleteMany({
      $or: [
        { userId },
        ...(accountIds.length ? [{ socialAccountIds: { $in: accountIds } }] : []),
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
      ],
    }),
    PublishedPost.deleteMany({
      $or: [
        { userId },
        ...(accountIds.length ? [{ accountId: { $in: accountIds } }] : []),
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
      ],
    }),
    PostMetricSnapshot.deleteMany(anyOf([
        ...(accountIds.length ? [{ accountId: { $in: accountIds } }] : []),
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
    ])),
    PostMetricDailySnapshot.deleteMany(anyOf([
        ...(accountIds.length ? [{ accountId: { $in: accountIds } }] : []),
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
    ])),
    PostInsight.deleteMany(anyOf([
        ...(accountIds.length ? [{ accountId: { $in: accountIds } }] : []),
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
    ])),
    Insight.deleteMany(anyOf([
        ...(accountIds.length ? [{ accountId: { $in: accountIds } }] : []),
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
    ])),
    MetricSyncStatus.deleteMany({ accountId: { $in: accountIds } }),
    Media.deleteMany({
      $or: [
        { userId },
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
      ],
    }),
    Folder.deleteMany({
      $or: [
        { userId },
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
      ],
    }),
    SavedCaption.deleteMany({ userId }),
    BulkAgentPlan.deleteMany({ userId }),
    BulkMediaReservation.deleteMany({ userId }),
    OAuthStateNonce.deleteMany({ userId }),
    CampaignChannel.deleteMany(anyOf([
        ...(accountIds.length ? [{ socialAccountId: { $in: accountIds } }] : []),
        ...(ownedCampaignIds.length ? [{ campaignId: { $in: ownedCampaignIds } }] : []),
    ])),
    SocialAccount.deleteMany({ userId }),
  ]);

  await CampaignChannel.updateMany(
    {
      $or: [
        { assignedHandlerUserId: userId },
        ...(user.email ? [{ assignedHandlerEmail: user.email.toLowerCase() }] : []),
      ],
    },
    { $set: { assignedHandlerUserId: null, assignedHandlerEmail: '' } },
  );
  await CampaignChannel.updateMany(
    { $or: [{ addedByUserId: userId }, { verifiedByUserId: userId }] },
    { $unset: { addedByUserId: '', verifiedByUserId: '' } },
  );

  await Campaign.updateMany(
    { $or: [{ accountIds: { $in: accountIds } }, { 'channels.socialAccountId': { $in: accountIds } }] },
    {
      $pull: {
        accountIds: { $in: accountIds },
        channels: { socialAccountId: { $in: accountIds } },
      },
    },
  );
  await Campaign.updateMany(
    {
      $or: [
        { 'channels.assignedHandlerUserId': userId },
        ...(user.email ? [{ 'channels.assignedHandlerEmail': user.email.toLowerCase() }] : []),
      ],
    },
    {
      $set: {
        'channels.$[channel].assignedHandlerUserId': null,
        'channels.$[channel].assignedHandlerEmail': '',
      },
    },
    {
      arrayFilters: [{
        $or: [
          { 'channel.assignedHandlerUserId': userId },
          ...(user.email ? [{ 'channel.assignedHandlerEmail': user.email.toLowerCase() }] : []),
        ],
      }],
    },
  );

  if (ownedCampaignIds.length) {
    await Campaign.deleteMany({ _id: { $in: ownedCampaignIds } });
  }
  await User.deleteOne({ _id: userId });

  return {
    userDeleted: true,
    accountsDeleted: accountIds.length,
    revocationFailures: revocationFailures.length,
  };
};
