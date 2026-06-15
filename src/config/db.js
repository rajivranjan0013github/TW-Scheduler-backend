import mongoose from 'mongoose';
import SocialAccount from '../models/SocialAccount.js';
import Folder from '../models/Folder.js';

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
      console.log(`🧹 Cleaned up ${cleanupResult.deletedCount} legacy mock social accounts from MongoDB.`);
    }

    // 2. Seed/Sync real accounts from environment variables if present
    const igToken = process.env.META_INSTAGRAM_ACCESS_TOKEN?.trim();
    const igAccountId = process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID?.trim();
    const fbToken = process.env.META_PAGE_ACCESS_TOKEN?.trim();
    const fbPageId = process.env.META_FACEBOOK_PAGE_ID?.trim();

    if (igToken && igAccountId) {
      console.log('🔄 Syncing real Instagram Business Account credentials from env to MongoDB...');
      await SocialAccount.findOneAndUpdate(
        { platform: 'instagram', accountId: igAccountId },
        { 
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
      console.log('🔄 Syncing real Facebook Page credentials from env to MongoDB...');
      await SocialAccount.findOneAndUpdate(
        { platform: 'facebook', accountId: fbPageId },
        { 
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

    // 3. Seed Folders if empty
    const folderCount = await Folder.countDocuments();
    if (folderCount === 0) {
      console.log('🌱 Seeding default folders in MongoDB...');
      await Folder.insertMany([
        { name: 'Summer Reels' },
        { name: 'Product Launches' },
        { name: 'Behind The Scenes' }
      ]);
    }
  } catch (error) {
    console.error('❌ Database seeding failed:', error.message);
  }
};

export const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI;
  

  if (!mongoUri) {
    console.log('⚠️ MONGODB_URI is not defined in .env. Database operations will use In-Memory Sandbox/Demo mode.');
    return false;
  }

  console.log('⏳ Connecting to MongoDB...');
  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
    });
    console.log(`🔌 MongoDB Connected: ${conn.connection.host}`);
    isConnected = true;

    // Run database seeder
    await seedDatabase();

    return true;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    console.log('⚠️ Running backend database operations in In-Memory Sandbox/Demo mode.');
    isConnected = false;
    return false;
  }
};

export const getDBStatus = () => isConnected;
