import Campaign from '../models/Campaign.js';
import CampaignChannel from '../models/CampaignChannel.js';
import SocialAccount from '../models/SocialAccount.js';
import ScheduledPost from '../models/ScheduledPost.js';
import PublishedPost from '../models/PublishedPost.js';
import Media from '../models/Media.js';
import { getCampaignAccessQuery } from '../utils/campaignAccess.js';

// Decides whether an admin may "View as handler" for a given handler. Owners may preview
// anyone; admins only handlers who work in a campaign the admin can access, which are the
// same people the admin's Team page lists for those campaigns.

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

const toKey = (value) => (value == null ? '' : String(value));
const normalizeEmail = (email = '') => String(email || '').trim().toLowerCase();

export const clearPreviewAccessCache = () => cache.clear();

const checkAccess = async (adminUser, handlerUser) => {
  if (adminUser.role === 'owner') return true;

  const campaigns = await Campaign.find(getCampaignAccessQuery({ user: adminUser }))
    .select('_id accountIds channels.socialAccountId channels.assignedHandlerUserId channels.assignedHandlerEmail')
    .lean();
  if (!campaigns.length) return false;

  const handlerId = toKey(handlerUser._id);
  const handlerEmail = normalizeEmail(handlerUser.email);

  // Assigned to one of the campaign's channels
  const assignedInCampaign = campaigns.some((campaign) => (campaign.channels || []).some((channel) => (
    toKey(channel.assignedHandlerUserId) === handlerId
    || (handlerEmail && normalizeEmail(channel.assignedHandlerEmail) === handlerEmail)
  )));
  if (assignedInCampaign) return true;

  const campaignIds = campaigns.map((campaign) => campaign._id);
  const assignedChannel = await CampaignChannel.exists({
    campaignId: { $in: campaignIds },
    $or: [
      { assignedHandlerUserId: handlerUser._id },
      ...(handlerEmail ? [{ assignedHandlerEmail: handlerEmail }] : []),
    ],
  });
  if (assignedChannel) return true;

  // Owns an account linked to one of the campaigns
  const channelAccountIds = await CampaignChannel.distinct('socialAccountId', {
    campaignId: { $in: campaignIds },
    socialAccountId: { $ne: null },
  });
  const linkedAccountIds = [
    ...campaigns.flatMap((campaign) => [
      ...(campaign.accountIds || []),
      ...(campaign.channels || []).map((channel) => channel.socialAccountId),
    ]),
    ...channelAccountIds,
  ].filter(Boolean);
  const ownsLinkedAccount = await SocialAccount.exists({
    userId: handlerUser._id,
    $or: [
      { campaignId: { $in: campaignIds } },
      { _id: { $in: linkedAccountIds } },
    ],
  });
  if (ownsLinkedAccount) return true;

  // Has posts or media in one of the campaigns
  const inCampaign = { userId: handlerUser._id, campaignId: { $in: campaignIds } };
  for (const model of [ScheduledPost, PublishedPost, Media]) {
    if (await model.exists(inCampaign)) return true;
  }
  return false;
};

/**
 * True when `adminUser` may preview `handlerUser`. Results are cached for a minute,
 * since the preview check runs on every request the previewed dashboard makes.
 */
export const canPreviewHandler = async (adminUser, handlerUser, now = Date.now()) => {
  const key = `${toKey(adminUser._id)}:${adminUser.role}:${toKey(handlerUser._id)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.allowed;

  const allowed = await checkAccess(adminUser, handlerUser);
  cache.set(key, { allowed, expiresAt: now + CACHE_TTL_MS });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return allowed;
};
