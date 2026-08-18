import 'dotenv/config';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import { ensureDefaultCampaignFolders } from '../services/campaignFolderService.js';

async function organizeAudio() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  // 1. Process Global Audio Folder
  const globalAudioFolder = await Folder.findOne({
    $or: [
      { name: 'Audio', parentFolderId: null, scope: 'global' },
      { name: 'Audio', parentFolderId: null, campaignId: null }
    ]
  });

  if (globalAudioFolder) {
    console.log('\n--- Organizing Global Audio Folder ---');
    let trendingGlobal = await Folder.findOne({
      parentFolderId: globalAudioFolder._id,
      name: /^trending songs$/i
    });
    if (!trendingGlobal) {
      trendingGlobal = await Folder.create({
        userId: globalAudioFolder.userId,
        campaignId: null,
        scope: 'global',
        name: 'Trending songs',
        parentFolderId: globalAudioFolder._id,
        kind: 'folder',
        tags: ['audio', 'trending'],
      });
      console.log('Created global subfolder: Trending songs');
    }

    let myOwnGlobal = await Folder.findOne({
      parentFolderId: globalAudioFolder._id,
      name: /^my own audios$/i
    });
    if (!myOwnGlobal) {
      myOwnGlobal = await Folder.create({
        userId: globalAudioFolder.userId,
        campaignId: null,
        scope: 'global',
        name: 'My own audios',
        parentFolderId: globalAudioFolder._id,
        kind: 'folder',
        tags: ['audio', 'custom'],
      });
      console.log('Created global subfolder: My own audios');
    }

    // Move audio files currently directly in global Audio to Trending songs
    const res = await Media.updateMany(
      { folderId: globalAudioFolder._id, type: 'audio' },
      { $set: { folderId: trendingGlobal._id } }
    );
    console.log(`Moved ${res.modifiedCount} audio files into 'Trending songs'.`);
  }

  // 2. Process Campaigns (e.g. Penguin Couples app & all campaigns)
  const campaigns = await Campaign.find({});
  console.log(`\n--- Ensuring Audio folders for ${campaigns.length} campaigns ---`);

  for (const campaign of campaigns) {
    await ensureDefaultCampaignFolders(campaign._id, campaign.createdBy);
    const audioFolder = await Folder.findOne({ campaignId: campaign._id, name: 'Audio', parentFolderId: null });
    if (audioFolder) {
      const myOwnFolder = await Folder.findOne({ campaignId: campaign._id, parentFolderId: audioFolder._id, name: /^my own audios$/i });
      // Move loose campaign audio files (with folderId: null or folderId: audioFolder._id) to My own audios
      if (myOwnFolder) {
        const looseRes = await Media.updateMany(
          { campaignId: campaign._id, type: 'audio', folderId: { $in: [null, audioFolder._id] } },
          { $set: { folderId: myOwnFolder._id } }
        );
        if (looseRes.modifiedCount > 0) {
          console.log(`Moved ${looseRes.modifiedCount} campaign audio files into '${campaign.name} > Audio > My own audios'.`);
        }
      }
    }
  }

  console.log('\n=============================================');
  console.log('Audio folders organized successfully!');
  console.log('=============================================');

  await mongoose.disconnect();
}

organizeAudio().catch(console.error);
