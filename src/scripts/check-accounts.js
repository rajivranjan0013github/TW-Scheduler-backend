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
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('Connected successfully!');

    const accounts = await SocialAccount.find({});
    console.log(`Found ${accounts.length} connected account(s):`);
    
    accounts.forEach(acc => {
      console.log(`- ID: ${acc._id}, Platform: ${acc.platform}, Name: ${acc.name}, Username: ${acc.username}, AccountID: ${acc.accountId}, Connected: ${acc.isConnected}`);
    });

    if (process.argv.includes('--delete')) {
      if (accounts.length === 0) {
        console.log('No accounts to delete.');
      } else {
        const accountIds = accounts.map(acc => acc._id);

        console.log('Deleting related insights...');
        const insightDel = await Insight.deleteMany({ accountId: { $in: accountIds } });
        console.log(`Deleted ${insightDel.deletedCount} insight entries.`);

        console.log('Deleting related post insights...');
        const postInsightDel = await PostInsight.deleteMany({ accountId: { $in: accountIds } });
        console.log(`Deleted ${postInsightDel.deletedCount} post insight entries.`);

        console.log('Deleting related published posts...');
        const publishedPostDel = await PublishedPost.deleteMany({ accountId: { $in: accountIds } });
        console.log(`Deleted ${publishedPostDel.deletedCount} published post entries.`);

        console.log('Cleaning up Campaign references...');
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
          console.log(`Cleaned up references in Campaign: "${campaign.name}"`);
        }

        console.log('Deleting connected accounts...');
        const result = await SocialAccount.deleteMany({});
        console.log(`Deleted ${result.deletedCount} account(s).`);
      }
    } else {
      console.log('\nRun with "--delete" flag to delete all these accounts and their related data, e.g.:');
      console.log('node src/scripts/check-accounts.js --delete');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
};

run();
