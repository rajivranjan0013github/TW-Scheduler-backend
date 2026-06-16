/**
 * Migration Script: Add userId to all existing documents
 * 
 * This script finds the first User in the database and assigns their _id
 * as the userId on all SocialAccount, ScheduledPost, Media, and Folder
 * documents that don't already have a userId set.
 * 
 * Usage: node src/scripts/migrate-add-userId.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import SocialAccount from '../models/SocialAccount.js';
import ScheduledPost from '../models/ScheduledPost.js';
import Media from '../models/Media.js';
import Folder from '../models/Folder.js';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not defined in .env');
  process.exit(1);
}

const migrate = async () => {
  try {
    console.log('⏳ Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('🔌 Connected to MongoDB.');

    // Find the first user (oldest by creation date)
    const firstUser = await User.findOne().sort({ createdAt: 1 });
    if (!firstUser) {
      console.error('❌ No users found in the database. Please create a user first by logging in.');
      process.exit(1);
    }

    console.log(`👤 Assigning all orphaned data to user: "${firstUser.name}" (${firstUser.email})`);
    const userId = firstUser._id;

    // Drop the old unique index on accountId if it exists (replaced by compound index)
    try {
      const collection = mongoose.connection.collection('socialaccounts');
      const indexes = await collection.indexes();
      const oldIndex = indexes.find(idx => idx.key?.accountId && !idx.key?.userId);
      if (oldIndex) {
        console.log(`🔧 Dropping old unique index on accountId: "${oldIndex.name}"`);
        await collection.dropIndex(oldIndex.name);
      }
    } catch (err) {
      // Index may not exist, that's fine
      if (!err.message.includes('index not found')) {
        console.warn('⚠️ Index cleanup warning:', err.message);
      }
    }

    // Update SocialAccounts
    const saResult = await SocialAccount.updateMany(
      { userId: { $exists: false } },
      { $set: { userId } }
    );
    console.log(`✅ SocialAccount: ${saResult.modifiedCount} documents updated`);

    // Also update docs where userId exists but is null
    const saResultNull = await SocialAccount.updateMany(
      { userId: null },
      { $set: { userId } }
    );
    console.log(`✅ SocialAccount (null userId): ${saResultNull.modifiedCount} documents updated`);

    // Update ScheduledPosts
    const spResult = await ScheduledPost.updateMany(
      { userId: { $exists: false } },
      { $set: { userId } }
    );
    console.log(`✅ ScheduledPost: ${spResult.modifiedCount} documents updated`);

    const spResultNull = await ScheduledPost.updateMany(
      { userId: null },
      { $set: { userId } }
    );
    console.log(`✅ ScheduledPost (null userId): ${spResultNull.modifiedCount} documents updated`);

    // Update Media
    const mediaResult = await Media.updateMany(
      { userId: { $exists: false } },
      { $set: { userId } }
    );
    console.log(`✅ Media: ${mediaResult.modifiedCount} documents updated`);

    const mediaResultNull = await Media.updateMany(
      { userId: null },
      { $set: { userId } }
    );
    console.log(`✅ Media (null userId): ${mediaResultNull.modifiedCount} documents updated`);

    // Update Folders
    const folderResult = await Folder.updateMany(
      { userId: { $exists: false } },
      { $set: { userId } }
    );
    console.log(`✅ Folder: ${folderResult.modifiedCount} documents updated`);

    const folderResultNull = await Folder.updateMany(
      { userId: null },
      { $set: { userId } }
    );
    console.log(`✅ Folder (null userId): ${folderResultNull.modifiedCount} documents updated`);

    // Summary
    const totalUpdated = saResult.modifiedCount + saResultNull.modifiedCount +
      spResult.modifiedCount + spResultNull.modifiedCount +
      mediaResult.modifiedCount + mediaResultNull.modifiedCount +
      folderResult.modifiedCount + folderResultNull.modifiedCount;

    console.log(`\n🎉 Migration complete! ${totalUpdated} total documents assigned to user "${firstUser.name}".`);

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB.');
  }
};

migrate();
