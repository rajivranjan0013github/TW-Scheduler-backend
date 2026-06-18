import mongoose from 'mongoose';
import SocialAccount from '../models/SocialAccount.js';
import Folder from '../models/Folder.js';
import User from '../models/User.js';

let isConnected = false;

const seedDatabase = async () => {
  try {
    // 1. Clean up any existing legacy mock social accounts
    const cleanupResult = await SocialAccount.deleteMany({
      $or: [
        { accountId: 'ig_travel_diaries' },
        { accountId: 'ig_tech_reviews' },
        { accountId: 'fb_page_travel' },
        { accountId: 'fb_page_tech' },
        { accessToken: { $regex: /^mock-access-token/ } }
      ]
    });
    if (cleanupResult.deletedCount > 0) {
    }

    // Find the first user to associate seeded data with
    const firstUser = await User.findOne().sort({ createdAt: 1 });
    if (!firstUser) {
      return;
    }
    const seedUserId = firstUser._id;

    // 2. Seed/Sync real accounts from environment variables if present
    const igToken = process.env.META_INSTAGRAM_ACCESS_TOKEN?.trim();
    const igAccountId = process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID?.trim();
    const fbToken = process.env.META_PAGE_ACCESS_TOKEN?.trim();
    const fbPageId = process.env.META_FACEBOOK_PAGE_ID?.trim();

    if (igToken && igAccountId) {
      await SocialAccount.findOneAndUpdate(
        { userId: seedUserId, platform: 'instagram', accountId: igAccountId },
        { 
          userId: seedUserId,
          platform: 'instagram', 
          accountId: igAccountId, 
          accessToken: igToken, 
          name: 'My Instagram Business Account',
          username: 'my_instagram_username',
          avatarUrl: 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=150'
        },
        { upsert: true }
      );
    }
    if (fbToken && fbPageId) {
      await SocialAccount.findOneAndUpdate(
        { userId: seedUserId, platform: 'facebook', accountId: fbPageId },
        { 
          userId: seedUserId,
          platform: 'facebook', 
          accountId: fbPageId, 
          accessToken: fbToken, 
          name: 'My Facebook Page',
          username: 'my_facebook_username',
          avatarUrl: 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=150'
        },
        { upsert: true }
      );
    }

    // 3. Seed Folders if this user has none
    const folderCount = await Folder.countDocuments({ userId: seedUserId });
    if (folderCount === 0) {
      await Folder.insertMany([
        { userId: seedUserId, name: 'Summer Reels' },
        { userId: seedUserId, name: 'Product Launches' },
        { userId: seedUserId, name: 'Behind The Scenes' }
      ]);
    }
  } catch (error) {
    console.error('❌ Database seeding failed:', error.message);
  }
};

export const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI;
  

  if (!mongoUri) {
    return false;
  }

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
    });
    isConnected = true;

    // Run database seeder
    await seedDatabase();

    return true;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    isConnected = false;
    return false;
  }
};

export const getDBStatus = () => isConnected;
