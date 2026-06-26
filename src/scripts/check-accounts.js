import 'dotenv/config';
import mongoose from 'mongoose';
import SocialAccount from '../models/SocialAccount.js';
import Insight from '../models/Insight.js';
import PublishedPost from '../models/PublishedPost.js';
import PostInsight from '../models/PostInsight.js';
import Campaign from '../models/Campaign.js';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not defined in .env');
  process.exit(1);
}

const run = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    const accounts = await SocialAccount.find({});
    
    accounts.forEach(acc => {
    });

    if (process.argv.includes('--delete')) {
      if (accounts.length === 0) {
      } else {
        const accountIds = accounts.map(acc => acc._id);

        const insightDel = await Insight.deleteMany({ accountId: { $in: accountIds } });

        const postInsightDel = await PostInsight.deleteMany({ accountId: { $in: accountIds } });

        const publishedPostDel = await PublishedPost.deleteMany({ accountId: { $in: accountIds } });

        const campaigns = await Campaign.find({
          $or: [
            { accountIds: { $in: accountIds } },
            { 'channels.socialAccountId': { $in: accountIds } }
          ]
        });

        for (const campaign of campaigns) {
          // Remove from accountIds
          campaign.accountIds = campaign.accountIds.filter(id => !accountIds.some(aid => aid.equals(id)));
          
          // Unset socialAccountId on channels
          campaign.channels = campaign.channels.map(ch => {
            if (ch.socialAccountId && accountIds.some(aid => aid.equals(ch.socialAccountId))) {
              ch.socialAccountId = null;
            }
            return ch;
          });

          await campaign.save();
        }

        const result = await SocialAccount.deleteMany({});
      }
    } else {
      
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
};

run();
