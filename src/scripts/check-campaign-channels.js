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
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    // 1. Look for all campaigns
    const campaigns = await Campaign.find({});

    let foundReferences = [];

    for (const campaign of campaigns) {
    

      if (campaign.channels && campaign.channels.length > 0) {
        campaign.channels.forEach(ch => {
          
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

    if (foundReferences.length === 0) {
    } else {
      for (const entry of foundReferences) {
      
        
        if (entry.channel.socialAccountId) {
          // Look up if this social account exists
          const socialAcc = await SocialAccount.findById(entry.channel.socialAccountId);
          if (socialAcc) {
          } else {
          }
        } else {
        }
      }
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
};

run();
