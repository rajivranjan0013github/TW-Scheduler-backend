import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import SocialAccount from '../models/SocialAccount.js';
import Campaign from '../models/Campaign.js';
import { resolveCampaignPublishingChannels } from '../utils/campaignChannels.js';

const MONGODB_URI = process.env.MONGODB_URI;

const run = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    const user = await User.findOne({ email: /ayushcursor1/i });
    const creatorAccounts = await SocialAccount.find({ userId: user._id }).lean();

    // Map handles to lowercase
    const accountLookupPairs = creatorAccounts.map(acc => {
      const handle = (acc.username || acc.name || '').replace(/^@/, '').toLowerCase();
      return { platform: acc.platform, handle };
    });

    // Find campaigns
    const orConditions = accountLookupPairs.map(({ platform, handle }) => ({
      'channels.platform': platform,
      'channels.handle': { $regex: new RegExp(`^@?${handle}$`, 'i') }
    }));

    const matchedCampaigns = await Campaign.find({ $or: orConditions }).lean();

    for (const campaign of matchedCampaigns) {
      const resolvedChannels = await resolveCampaignPublishingChannels(campaign, { persist: false });
     

      const creatorHandles = new Set(creatorAccounts.map(acc => 
        (acc.username || acc.name || '').replace(/^@/, '').toLowerCase()
      ));

      const creatorChannels = resolvedChannels
        .filter(ch => {
          const normalizedChHandle = (ch.handle || '').replace(/^@/, '').toLowerCase();
          const normalizedChUsername = (ch.username || '').replace(/^@/, '').toLowerCase();
          return creatorHandles.has(normalizedChHandle) || creatorHandles.has(normalizedChUsername);
        })
        .map(ch => ({
          platform: ch.platform,
          handle: ch.handle,
          username: ch.username,
          isVerified: ch.isVerified,
          status: ch.status
        }));

    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
};

run();
