import Campaign from '../models/Campaign.js';
import CampaignChannel from '../models/CampaignChannel.js';
import SocialAccount from '../models/SocialAccount.js';
import User from '../models/User.js';

export const normalizeChannelHandle = (value = '') => (
  String(value).trim().replace(/^@/, '').toLowerCase()
);

const idToString = (value) => value?._id?.toString?.() || value?.toString?.() || '';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const makeExactHandleRegex = (handle) => new RegExp(`^@?${escapeRegExp(handle)}$`, 'i');

const accountMatchesHandle = (account, platform, normalizedHandle) => (
  account?.platform === platform &&
  [
    normalizeChannelHandle(account.username),
    normalizeChannelHandle(account.name),
    normalizeChannelHandle(account.accountId),
  ].includes(normalizedHandle)
);

const findMatchingAccount = (channel, accounts = []) => {
  const normalizedHandle = channel.normalizedHandle || normalizeChannelHandle(channel.requestedHandle || channel.handle);
  if (!channel.platform || !normalizedHandle) return null;

  const linkedAccountId = idToString(channel.socialAccountId);
  const linkedMatch = linkedAccountId
    ? accounts.find((account) => idToString(account._id) === linkedAccountId)
    : null;
  if (linkedMatch) return linkedMatch;

  return accounts.find((account) => accountMatchesHandle(account, channel.platform, normalizedHandle)) || null;
};

const buildAccountLookupQuery = (channels = []) => {
  const lookups = channels
    .map((channel) => ({
      platform: channel.platform,
      handle: channel.normalizedHandle || normalizeChannelHandle(channel.requestedHandle || channel.handle),
    }))
    .filter((item) => item.platform && item.handle);

  if (lookups.length === 0) return null;

  return {
    $or: lookups.map(({ platform, handle }) => {
      const exactHandle = makeExactHandleRegex(handle);
      return {
        platform,
        $or: [
          { username: exactHandle },
          { name: exactHandle },
          { accountId: exactHandle },
        ],
      };
    }),
  };
};

const normalizeChannelInput = (channel) => {
  const requestedHandle = String(channel.requestedHandle || channel.handle || '').trim();
  const normalizedHandle = normalizeChannelHandle(requestedHandle);
  const assignedHandlerEmail = String(channel.assignedHandlerEmail || '').trim().toLowerCase();
  return {
    _id: channel._id,
    platform: channel.platform,
    requestedHandle,
    normalizedHandle,
    displayName: channel.displayName?.trim?.() || '',
    socialAccountId: channel.socialAccountId || null,
    assignedHandlerEmail,
    assignedHandlerUserId: channel.assignedHandlerUserId || null,
    addedAt: channel.addedAt || channel.createdAt || new Date(),
  };
};

const cleanChannelInputs = (channels = []) => (
  channels
    .map(normalizeChannelInput)
    .filter((channel) => channel.platform && channel.requestedHandle && channel.normalizedHandle)
);

const loadCampaignChannels = async (campaign, { persist = false, addedByUserId = null } = {}) => {
  const campaignId = campaign?._id || campaign;
  if (!campaignId) return [];

  let channelDocs = await CampaignChannel.find({ campaignId }).sort({ createdAt: 1 }).lean();

  const legacyChannels = cleanChannelInputs((campaign?.toObject ? campaign.toObject() : campaign)?.channels || []);
  if (channelDocs.length === 0 && legacyChannels.length > 0) {
    const docs = legacyChannels.map((channel) => ({
      campaignId,
      platform: channel.platform,
      requestedHandle: channel.requestedHandle,
      normalizedHandle: channel.normalizedHandle,
      displayName: channel.displayName,
      socialAccountId: channel.socialAccountId || null,
      assignedHandlerEmail: channel.assignedHandlerEmail || '',
      assignedHandlerUserId: channel.assignedHandlerUserId || null,
      addedByUserId,
      createdAt: channel.addedAt,
      updatedAt: channel.addedAt,
    }));

    if (persist) {
      await CampaignChannel.insertMany(docs, { ordered: false }).catch(() => {});
      channelDocs = await CampaignChannel.find({ campaignId }).sort({ createdAt: 1 }).lean();
    } else {
      channelDocs = docs;
    }
  }

  return channelDocs;
};

export const syncCampaignChannelList = async (campaignId, channels = [], { userId = null } = {}) => {
  const cleanChannels = cleanChannelInputs(channels);
  const keepKeys = new Set(cleanChannels.map((channel) => `${channel.platform}:${channel.normalizedHandle}`));

  const existing = await CampaignChannel.find({ campaignId }).lean();
  const existingByKey = new Map(
    existing.map((channel) => [`${channel.platform}:${channel.normalizedHandle}`, channel])
  );

  await CampaignChannel.deleteMany({
    campaignId,
    $or: [
      { platform: { $nin: cleanChannels.map((channel) => channel.platform) } },
      ...existing
        .filter((channel) => !keepKeys.has(`${channel.platform}:${channel.normalizedHandle}`))
        .map((channel) => ({ _id: channel._id })),
    ],
  });

  for (const channel of cleanChannels) {
    const existingChannel = existingByKey.get(`${channel.platform}:${channel.normalizedHandle}`);
    const assignedUser = channel.assignedHandlerEmail
      ? await User.findOne({ email: channel.assignedHandlerEmail }).select('_id').lean()
      : null;
    await CampaignChannel.findOneAndUpdate(
      {
        campaignId,
        platform: channel.platform,
        normalizedHandle: channel.normalizedHandle,
      },
      {
        campaignId,
        platform: channel.platform,
        requestedHandle: channel.requestedHandle,
        normalizedHandle: channel.normalizedHandle,
        displayName: channel.displayName,
        socialAccountId: existingChannel?.socialAccountId || channel.socialAccountId || null,
        assignedHandlerEmail: channel.assignedHandlerEmail,
        assignedHandlerUserId: existingChannel?.status === 'verified'
          ? existingChannel?.assignedHandlerUserId || null
          : assignedUser?._id || channel.assignedHandlerUserId || null,
        addedByUserId: existingChannel?.addedByUserId || userId || undefined,
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  }

  const campaign = await Campaign.findById(campaignId);
  return resolveCampaignPublishingChannels(campaign, { persist: true });
};

export const resolveCampaignPublishingChannels = async (
  campaign,
  { persist = false, addedByUserId = null } = {}
) => {
  if (!campaign) return [];

  const campaignObject = campaign.toObject ? campaign.toObject() : campaign;
  const campaignId = campaignObject._id;
  const channelDocs = await loadCampaignChannels(campaign, { persist, addedByUserId });

  if (channelDocs.length === 0) {
    if (persist && campaignId) {
      await Campaign.findByIdAndUpdate(campaignId, { accountIds: [], channels: [] });
    }
    return [];
  }

  const linkedIds = channelDocs.map((channel) => idToString(channel.socialAccountId)).filter(Boolean);
  const accountQuery = buildAccountLookupQuery(channelDocs);
  const accountQueryOr = [];
  if (linkedIds.length > 0) {
    accountQueryOr.push({ _id: { $in: linkedIds } });
  }
  if (accountQuery) {
    accountQueryOr.push(accountQuery);
  }

  const accounts = accountQueryOr.length > 0
    ? await SocialAccount.find({ $or: accountQueryOr })
        .select('_id userId platform accountId name username avatarUrl isConnected tokenExpiresAt authProvider')
        .lean()
    : [];
  const accountOwnerIds = [...new Set(accounts.map((account) => idToString(account.userId)).filter(Boolean))];
  const accountOwners = accountOwnerIds.length > 0
    ? await User.find({ _id: { $in: accountOwnerIds } }).select('_id name email').lean()
    : [];
  const accountOwnerById = new Map(
    accountOwners.map((owner) => [idToString(owner._id), owner])
  );

  const resolvedChannels = channelDocs.map((channel) => {
    const matched = findMatchingAccount(channel, accounts);
    const isConnected = Boolean(matched && matched.isConnected !== false);
    const matchedOwner = matched?.userId ? accountOwnerById.get(idToString(matched.userId)) : null;
    const socialAccountId = matched?._id || channel.socialAccountId || null;
    const status = isConnected
      ? 'verified'
      : socialAccountId
        ? 'disconnected'
        : 'pending_verification';
    const requestedHandle = channel.requestedHandle || channel.handle;

    return {
      _id: channel._id,
      platform: channel.platform,
      handle: requestedHandle,
      requestedHandle,
      displayName: channel.displayName || '',
      addedAt: channel.createdAt || channel.addedAt,
      socialAccountId,
      accountId: matched?.accountId || '',
      name: matched?.name || channel.displayName || requestedHandle,
      username: matched?.username || normalizeChannelHandle(requestedHandle),
      avatarUrl: matched?.avatarUrl || null,
      isConnected,
      isVerified: isConnected,
      status,
      userId: matched?.userId || null,
      matchedAccountId: matched?._id || null,
      assignedHandlerEmail: isConnected
        ? (matchedOwner?.email || '')
        : (channel.assignedHandlerEmail || ''),
      assignedHandlerName: isConnected
        ? (matchedOwner?.name || matched?.name || matched?.username || '')
        : '',
      assignedHandlerUserId: matched?.userId || channel.assignedHandlerUserId || null,
      campaignId,
      tokenExpiresAt: matched?.tokenExpiresAt || null,
      verifiedAt: isConnected ? (channel.verifiedAt || new Date()) : null,
      verifiedByUserId: isConnected ? (channel.verifiedByUserId || matched?.userId || null) : null,
    };
  });

  if (persist && campaignId) {
    const validAccountIds = resolvedChannels
      .filter((channel) => channel.isVerified && channel.socialAccountId)
      .map((channel) => channel.socialAccountId);

    await Promise.all(resolvedChannels.map((channel) => (
      CampaignChannel.findByIdAndUpdate(channel._id, {
        socialAccountId: channel.isVerified ? channel.socialAccountId : null,
        status: channel.status,
        assignedHandlerEmail: channel.assignedHandlerEmail || '',
        assignedHandlerUserId: channel.isVerified ? (channel.verifiedByUserId || channel.assignedHandlerUserId || null) : (channel.assignedHandlerUserId || null),
        verifiedAt: channel.isVerified ? channel.verifiedAt : null,
        verifiedByUserId: channel.isVerified ? channel.verifiedByUserId : null,
      })
    )));

    await Campaign.findByIdAndUpdate(campaignId, {
      channels: resolvedChannels.map((channel) => ({
        platform: channel.platform,
        handle: channel.requestedHandle,
        displayName: channel.displayName,
        socialAccountId: channel.isVerified ? channel.socialAccountId : null,
        assignedHandlerEmail: channel.assignedHandlerEmail || '',
        assignedHandlerUserId: channel.assignedHandlerUserId || null,
        addedAt: channel.addedAt || new Date(),
      })),
      accountIds: validAccountIds,
    });
  }

  return resolvedChannels;
};

export const canAccountVerifyCampaign = async (campaignId, accountPayload) => {
  if (!campaignId || !accountPayload?.platform) return false;

  const campaign = await Campaign.findById(campaignId).select('channels status').lean();
  if (!campaign || campaign.status === 'archived') return false;

  const channels = await loadCampaignChannels(campaign, { persist: true });
  return channels.some((channel) => (
    accountMatchesHandle(
      accountPayload,
      channel.platform,
      channel.normalizedHandle || normalizeChannelHandle(channel.requestedHandle)
    )
  ));
};

export const linkSocialAccountToCampaignChannels = async (campaignId, accountPayload) => {
  if (!campaignId || !accountPayload?._id || !accountPayload?.platform) return [];

  const channels = await CampaignChannel.find({ campaignId, platform: accountPayload.platform });
  const matched = channels.filter((channel) => (
    accountMatchesHandle(accountPayload, channel.platform, channel.normalizedHandle)
  ));

  for (const channel of matched) {
    channel.socialAccountId = accountPayload._id;
    channel.status = accountPayload.isConnected === false ? 'disconnected' : 'verified';
    channel.verifiedAt = channel.status === 'verified' ? new Date() : null;
    channel.verifiedByUserId = channel.status === 'verified' ? accountPayload.userId : null;
    if (channel.status === 'verified') {
      channel.assignedHandlerUserId = accountPayload.userId || null;
      channel.assignedHandlerEmail = accountPayload.userEmail || channel.assignedHandlerEmail || '';
    }
    await channel.save();
  }

  const campaign = await Campaign.findById(campaignId);
  await resolveCampaignPublishingChannels(campaign, { persist: true });
  return matched;
};
