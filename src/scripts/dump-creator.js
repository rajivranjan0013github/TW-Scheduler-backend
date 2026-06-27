import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import SocialAccount from '../models/SocialAccount.js';
import Campaign from '../models/Campaign.js';
import CampaignChannel from '../models/CampaignChannel.js';

const MONGODB_URI = process.env.MONGODB_URI;

const run = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    
    const users = await User.find({});

    const accounts = await SocialAccount.find({});
   

    const campaigns = await Campaign.find({});
   

    const cc = await CampaignChannel.find({});
  

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
};

run();
