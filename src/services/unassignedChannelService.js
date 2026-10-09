import CampaignChannel from '../models/CampaignChannel.js';
import SocialAccount from '../models/SocialAccount.js';

export const findUnassignedAccounts = async (accountFilter = {}) => {
  const assignedAccountIds = await CampaignChannel.distinct('socialAccountId', {
    socialAccountId: { $ne: null },
  });
  return SocialAccount.find({
    ...accountFilter,
    isConnected: true,
    _id: { $nin: assignedAccountIds },
  })
    .populate('userId', 'name email')
    .sort({ name: 1, _id: 1 })
    .lean();
};

export const assertAccountNotAssignedElsewhere = async (socialAccountId, campaignId) => {
  const assigned = await CampaignChannel.exists({
    socialAccountId,
    campaignId: { $ne: campaignId },
  });
  if (assigned) {
    const error = new Error('This channel has already been assigned to another campaign. Refresh the list to choose another channel.');
    error.statusCode = 409;
    throw error;
  }
};
