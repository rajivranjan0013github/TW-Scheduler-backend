import 'dotenv/config';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import SocialAccount from '../models/SocialAccount.js';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not defined in .env');
  process.exit(1);
}

const run = async () => {
  try {
    await mongoose.connect(MONGODB_URI);

    // 1. Find the SocialAccount for @themedicalmind2
    const socialAcc = await SocialAccount.findOne({ username: '@themedicalmind2', platform: 'youtube' });
    if (!socialAcc) {
      console.error('❌ SocialAccount for @themedicalmind2 not found!');
      process.exit(1);
    }

    // 2. Find the Campaign "odyssey"
    const campaign = await Campaign.findOne({ name: 'odyssey' });
    if (!campaign) {
      console.error('❌ Campaign "odyssey" not found!');
      process.exit(1);
    }

    // 3. Link them:
    // Update SocialAccount campaignId
    socialAcc.campaignId = campaign._id;
    await socialAcc.save();

    // Update Campaign channels and accountIds
    let updatedChannels = false;
    campaign.channels = campaign.channels.map(ch => {
      if (ch.platform === 'youtube' && ch.handle?.toLowerCase().includes('themedicalmind2')) {
        ch.socialAccountId = socialAcc._id;
        updatedChannels = true;
      }
      return ch;
    });

    if (!campaign.accountIds.includes(socialAcc._id)) {
      campaign.accountIds.push(socialAcc._id);
    }

    await campaign.save();
  

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
};

run();
