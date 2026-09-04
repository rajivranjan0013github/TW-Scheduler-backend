import 'dotenv/config';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import { ensureDefaultCampaignFolders } from '../services/campaignFolderService.js';

async function organizeAudio() {
  await mongoose.connect(process.env.MONGODB_URI);

  // 1. Process Global Audio Folder
  const globalAudioFolder = await Folder.findOne({
    $or: [
      { name: 'Audio', parentFolderId: null, scope: 'global' },
      { name: 'Audio', parentFolderId: null, campaignId: null }
    ]
  });

  if (globalAudioFolder) {
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
    }

    // Move audio files currently directly in global Audio to Trending songs
    const res = await Media.updateMany(
      { folderId: globalAudioFolder._id, type: 'audio' },
      { $set: { folderId: trendingGlobal._id } }
    );
  }

  // 2. Process Campaigns (e.g. Penguin Couples app & all campaigns)
  const campaigns = await Campaign.find({});

  for (const campaign of campaigns) {
    await ensureDefaultCampaignFolders(campaign._id, campaign.createdBy);
    const audioFolder = await Folder.findOne({ campaignId: campaign._id, name: 'Audio', parentFolderId: null });
    if (audioFolder) {
      const myOwnFolder = await Folder.findOne({ campaignId: campaign._id, parentFolderId: audioFolder._id, name: /^my own audios$/i });
      // Move loose campaign audio files (with folderId: null or folderId: audioFolder._id) to My own audios
      if (myOwnFolder) {
        await Media.updateMany(
          { campaignId: campaign._id, type: 'audio', folderId: { $in: [null, audioFolder._id] } },
          { $set: { folderId: myOwnFolder._id } }
        );
      }
    }
  }

  await mongoose.disconnect();
}

organizeAudio().catch(console.error);
