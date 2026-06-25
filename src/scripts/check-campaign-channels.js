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
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('Connected successfully!');

    // 1. Look for all campaigns
    const campaigns = await Campaign.find({});
    console.log(`Found ${campaigns.length} campaigns in total.`);

    let foundReferences = [];

    for (const campaign of campaigns) {
      console.log(`\nCampaign: "${campaign.name}" (ID: ${campaign._id})`);
      console.log(`- accountIds count: ${campaign.accountIds?.length || 0}`);
      console.log(`- channels count: ${campaign.channels?.length || 0}`);

      if (campaign.channels && campaign.channels.length > 0) {
        campaign.channels.forEach(ch => {
          console.log(`  * Channel Platform: ${ch.platform}, Handle: "${ch.handle}", DisplayName: "${ch.displayName}", SocialAccountRef: ${ch.socialAccountId}`);
          
          if (
            ch.handle?.toLowerCase().includes('themedicalmind2') || 
            ch.displayName?.toLowerCase().includes('themedicalmind')
          ) {
            foundReferences.push({
              campaignId: campaign._id,
              campaignName: campaign.name,
              channel: ch
            });
          }
        });
      }
    }

    console.log('\n--- Search Results for themedicalmind2 ---');
    if (foundReferences.length === 0) {
      console.log('No channels matching "themedicalmind2" were found in the Campaign channels list.');
    } else {
      console.log(`Found ${foundReferences.length} matching channel entries:`);
      for (const entry of foundReferences) {
        console.log(`\nCampaign: "${entry.campaignName}" (${entry.campaignId})`);
        console.log(`Channel Handle: "${entry.channel.handle}"`);
        console.log(`Channel Display Name: "${entry.channel.displayName}"`);
        console.log(`Platform: ${entry.channel.platform}`);
        console.log(`Associated socialAccountId Ref: ${entry.channel.socialAccountId}`);
        
        if (entry.channel.socialAccountId) {
          // Look up if this social account exists
          const socialAcc = await SocialAccount.findById(entry.channel.socialAccountId);
          if (socialAcc) {
            console.log(`Status: AUTHENTICATED/CONNECTED (SocialAccount exists: ID ${socialAcc._id}, Connected: ${socialAcc.isConnected})`);
          } else {
            console.log(`Status: NOT AUTHENTICATED / DISCONNECTED (The referenced SocialAccount ${entry.channel.socialAccountId} was deleted or does not exist)`);
          }
        } else {
          console.log(`Status: NOT AUTHENTICATED (No associated socialAccountId)`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
};

run();
