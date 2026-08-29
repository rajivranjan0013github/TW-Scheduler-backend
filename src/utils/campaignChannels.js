import Campaign from '../models/Campaign.js';
import CampaignChannel from '../models/CampaignChannel.js';
import SocialAccount from '../models/SocialAccount.js';
import User from '../models/User.js';

export const normalizeChannelHandle = (value = '') => {
  let str = String(value || '').trim().toLowerCase();
  // Strip URL protocol and domain prefixes for YouTube, Instagram, Facebook, TikTok, Twitter/X
  str = str.replace(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|instagram\.com|facebook\.com|tiktok\.com|twitter\.com|x\.com)\//i, '');
  // Strip channel, c, user, or @ prefixes
  str = str.replace(/^(channel\/|c\/|user\/|@)/i, '');
  // Strip query parameters and trailing slashes
  str = str.split('?')[0].replace(/\/+$/, '');
  // Transliterate German umlauts & special characters
  str = str.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  return str;
};

export const toFuzzyHandleKey = (value = '') => {
  return normalizeChannelHandle(value).replace(/[^a-z0-9]/g, '');
};

const idToString = (value) => value?._id?.toString?.() || value?.toString?.() || '';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const makeExactHandleRegex = (handle) => new RegExp(`^@?${escapeRegExp(handle)}$`, 'i');

export const accountMatchesHandle = (account, platform, normalizedHandle) => {
  if (!account || account?.platform !== platform || !normalizedHandle) return false;

  const targetNorm = normalizeChannelHandle(normalizedHandle);
  const targetFuzzy = toFuzzyHandleKey(normalizedHandle);

  const candidateValues = [
    account.username,
    account.name,
    account.accountId,
    account.displayName,
  ].filter(Boolean);

  return candidateValues.some((cand) => {
    const candNorm = normalizeChannelHandle(cand);
    const candFuzzy = toFuzzyHandleKey(cand);
    if (!candNorm) return false;
    return (
      candNorm === targetNorm ||
      (candFuzzy && candFuzzy === targetFuzzy) ||
      (candNorm.length >= 4 && targetNorm.length >= 4 && (candNorm.includes(targetNorm) || targetNorm.includes(candNorm)))
    );
  });
};

const findMatchingAccount = (channel, accounts = []) => {
  const normalizedHandle = channel.normalizedHandle || normalizeChannelHandle(channel.requestedHandle || channel.handle);
  if (!channel.platform || !normalizedHandle) return null;

  const linkedAccountId = idToString(channel.socialAccountId);
  const linkedMatch = linkedAccountId
    ? accounts.find((account) => idToString(account._id) === linkedAccountId)
    : null;
  if (linkedMatch) return linkedMatch;

  const handleMatches = accounts.filter((account) => (
    accountMatchesHandle(account, channel.platform, normalizedHandle)
  ));
  return handleMatches.find((account) => account.isConnected !== false) || handleMatches[0] || null;
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
  const existing = await CampaignChannel.find({ campaignId }).lean();
  const existingByKey = new Map(
    existing.map((channel) => [`${channel.platform}:${channel.normalizedHandle}`, channel])
  );
  const existingById = new Map(
    existing.map((channel) => [idToString(channel._id), channel])
  );

  const keepIds = new Set(
    cleanChannels
      .map((channel) => channel._id ? idToString(channel._id) : null)
      .filter(Boolean)
  );
  const keepKeys = new Set(
    cleanChannels.map((channel) => `${channel.platform}:${channel.normalizedHandle}`)
  );

  await CampaignChannel.deleteMany({
    campaignId,
    $or: [
      { platform: { $nin: cleanChannels.map((channel) => channel.platform) } },
      ...existing
        .filter((channel) => !keepIds.has(idToString(channel._id)) && !keepKeys.has(`${channel.platform}:${channel.normalizedHandle}`))
        .map((channel) => ({ _id: channel._id })),
    ],
  });

  for (const channel of cleanChannels) {
    const existingChannel = (channel._id ? existingById.get(idToString(channel._id)) : null)
      || existingByKey.get(`${channel.platform}:${channel.normalizedHandle}`);

    const assignedUser = channel.assignedHandlerEmail
      ? await User.findOne({ email: channel.assignedHandlerEmail }).select('_id').lean()
      : null;

    const query = existingChannel?._id
      ? { _id: existingChannel._id }
      : { campaignId, platform: channel.platform, normalizedHandle: channel.normalizedHandle };

    await CampaignChannel.findOneAndUpdate(
      query,
      {
        campaignId,
        platform: channel.platform,
        requestedHandle: channel.requestedHandle,
        normalizedHandle: channel.normalizedHandle,
        displayName: channel.displayName,
        socialAccountId: existingChannel?.socialAccountId || channel.socialAccountId || null,
        assignedHandlerEmail: channel.assignedHandlerEmail,
        assignedHandlerUserId: channel.assignedHandlerEmail
          ? (assignedUser?._id || null)
          : (existingChannel?.status === 'verified'
            ? existingChannel?.assignedHandlerUserId || null
            : null),
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
        .select('_id userId platform accountId name username avatarUrl isConnected tokenExpiresAt tokenStatus authProvider analyticsStatus analyticsError')
        .lean()
    : [];
  const accountOwnerIds = [...new Set(accounts.map((account) => idToString(account.userId)).filter(Boolean))];
  const assignedHandlerIds = [...new Set(
    channelDocs.map((channel) => idToString(channel.assignedHandlerUserId)).filter(Boolean)
  )];
  const assignedHandlerEmails = [...new Set(
    channelDocs
      .map((channel) => String(channel.assignedHandlerEmail || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  const relatedUserQuery = [];
  const relatedUserIds = [...new Set([...accountOwnerIds, ...assignedHandlerIds])];
  if (relatedUserIds.length > 0) relatedUserQuery.push({ _id: { $in: relatedUserIds } });
  if (assignedHandlerEmails.length > 0) relatedUserQuery.push({ email: { $in: assignedHandlerEmails } });
  const relatedUsers = relatedUserQuery.length > 0
    ? await User.find({ $or: relatedUserQuery }).select('_id name email').lean()
    : [];
  const accountOwnerById = new Map(
    relatedUsers.map((owner) => [idToString(owner._id), owner])
  );
  const userByEmail = new Map(
    relatedUsers
      .filter((user) => user.email)
      .map((user) => [String(user.email).trim().toLowerCase(), user])
  );

  const resolvedChannels = channelDocs.map((channel) => {
    const matched = findMatchingAccount(channel, accounts);
    const isConnected = Boolean(matched && matched.isConnected !== false);
    const matchedOwner = matched?.userId ? accountOwnerById.get(idToString(matched.userId)) : null;
    const assignedHandlerEmail = String(channel.assignedHandlerEmail || '').trim().toLowerCase();
    const assignedHandler = channel.assignedHandlerUserId
      ? accountOwnerById.get(idToString(channel.assignedHandlerUserId))
      : userByEmail.get(assignedHandlerEmail);
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
      assignedHandlerEmail: assignedHandlerEmail || (isConnected
        ? (matchedOwner?.email || '')
        : ''),
      assignedHandlerName: assignedHandlerEmail
        ? (assignedHandler?.name || (matchedOwner?.email === assignedHandlerEmail
          ? (matchedOwner?.name || matched?.name || matched?.username || '')
          : ''))
        : (isConnected
          ? (matchedOwner?.name || matched?.name || matched?.username || '')
          : ''),
      assignedHandlerUserId: assignedHandlerEmail
        ? (channel.assignedHandlerUserId || null)
        : (matched?.userId || channel.assignedHandlerUserId || null),
      campaignId,
      tokenExpiresAt: matched?.tokenExpiresAt || null,
      tokenStatus: matched?.tokenStatus || 'unknown',
      analyticsStatus: matched?.analyticsStatus || 'unknown',
      analyticsError: matched?.analyticsError || '',
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
        // Keep the account identity while its token is expired. Reauthorization
        // must update this account instead of treating the channel as brand new.
        socialAccountId: channel.socialAccountId || null,
        status: channel.status,
        assignedHandlerEmail: channel.assignedHandlerEmail || '',
        assignedHandlerUserId: channel.isVerified ? (channel.assignedHandlerUserId || channel.verifiedByUserId || null) : (channel.assignedHandlerUserId || null),
        verifiedAt: channel.isVerified ? channel.verifiedAt : null,
        verifiedByUserId: channel.isVerified ? channel.verifiedByUserId : null,
      })
    )));

    await Campaign.findByIdAndUpdate(campaignId, {
      channels: resolvedChannels.map((channel) => ({
        platform: channel.platform,
        handle: channel.requestedHandle,
        displayName: channel.displayName,
        socialAccountId: channel.socialAccountId || null,
        assignedHandlerEmail: channel.assignedHandlerEmail || '',
        assignedHandlerUserId: channel.assignedHandlerUserId || null,
        addedAt: channel.addedAt || new Date(),
      })),
      accountIds: validAccountIds,
    });
  }

  return resolvedChannels;
};

export const canAccountVerifyCampaign = async (campaignId, accountPayload, user = null) => {
  if (!campaignId || !accountPayload?.platform) return false;

  const campaign = await Campaign.findById(campaignId).select('channels status').lean();
  if (!campaign || campaign.status === 'archived') return false;

  const channels = await loadCampaignChannels(campaign, { persist: true });
  const platformChannels = channels.filter((ch) => ch.platform === accountPayload.platform);
  if (platformChannels.length === 0) return false;

  // 1. Direct or fuzzy handle match
  const hasHandleMatch = platformChannels.some((channel) => (
    accountMatchesHandle(
      accountPayload,
      channel.platform,
      channel.normalizedHandle || normalizeChannelHandle(channel.requestedHandle)
    )
  ));
  if (hasHandleMatch) return true;

  // 2. Assigned handler match (user connecting is explicitly assigned to a channel of this platform in this campaign)
  if (user) {
    const userEmail = String(user.email || '').trim().toLowerCase();
    const userIdStr = idToString(user._id);
    const isAssigned = platformChannels.some((channel) => {
      const handlerEmail = String(channel.assignedHandlerEmail || '').trim().toLowerCase();
      const handlerUserId = idToString(channel.assignedHandlerUserId);
      return (userEmail && handlerEmail === userEmail) || (userIdStr && handlerUserId === userIdStr);
    });
    if (isAssigned) return true;
  }

  return false;
};

export const linkSocialAccountToCampaignChannels = async (campaignId, accountPayload) => {
  if (!campaignId || !accountPayload?._id || !accountPayload?.platform) return [];

  const channels = await CampaignChannel.find({ campaignId, platform: accountPayload.platform });

  // 1. Try matching channels by existing linked socialAccountId or handle
  let matched = channels.filter((channel) => (
    (channel.socialAccountId && idToString(channel.socialAccountId) === idToString(accountPayload._id)) ||
    accountMatchesHandle(accountPayload, channel.platform, channel.normalizedHandle)
  ));

  // 2. If no direct handle match was found, look for pending channels assigned to the connecting user
  if (matched.length === 0 && (accountPayload.userId || accountPayload.userEmail)) {
    const userEmail = String(accountPayload.userEmail || '').trim().toLowerCase();
    const userIdStr = idToString(accountPayload.userId);

    const assignedPending = channels.filter((channel) => {
      const handlerEmail = String(channel.assignedHandlerEmail || '').trim().toLowerCase();
      const handlerUserId = idToString(channel.assignedHandlerUserId);
      const isPending = channel.status !== 'verified' || !channel.socialAccountId;
      return isPending && ((userEmail && handlerEmail === userEmail) || (userIdStr && handlerUserId === userIdStr));
    });

    if (assignedPending.length > 0) {
      matched = assignedPending;
    }
  }

  for (const channel of matched) {
    channel.socialAccountId = accountPayload._id;
    channel.status = accountPayload.isConnected === false ? 'disconnected' : 'verified';
    channel.verifiedAt = channel.status === 'verified' ? new Date() : null;
    channel.verifiedByUserId = channel.status === 'verified' ? (accountPayload.userId || channel.verifiedByUserId || null) : null;
    if (channel.status === 'verified') {
      channel.assignedHandlerUserId = accountPayload.userId || channel.assignedHandlerUserId || null;
      channel.assignedHandlerEmail = accountPayload.userEmail || channel.assignedHandlerEmail || '';
      if (accountPayload.username || accountPayload.name) {
        channel.displayName = accountPayload.name || channel.displayName || '';
        channel.requestedHandle = accountPayload.username || accountPayload.name || channel.requestedHandle;
        channel.normalizedHandle = normalizeChannelHandle(channel.requestedHandle);
      }
    }
    await channel.save();
  }

  const campaign = await Campaign.findById(campaignId);
  await resolveCampaignPublishingChannels(campaign, { persist: true });
  return matched;
};
