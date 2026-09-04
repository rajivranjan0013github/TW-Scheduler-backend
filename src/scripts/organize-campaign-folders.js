import 'dotenv/config';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import { ensureDefaultCampaignFolders } from '../services/campaignFolderService.js';

async function organize() {
  await mongoose.connect(process.env.MONGODB_URI);

  const campaign = await Campaign.findOne({ name: /penguin/i });
  if (!campaign) {
    throw new Error('Penguin campaign not found!');
  }

  // 1. Ensure the 3 standard folders exist: Hooks, App Showcase, Generated
  const defaultFolders = await ensureDefaultCampaignFolders(campaign._id, campaign.createdBy);
  const hooksFolder = defaultFolders?.Hooks || await Folder.findOne({ campaignId: campaign._id, name: /^hooks$/i });
  const showcaseFolder = defaultFolders?.['App Showcase'] || await Folder.findOne({ campaignId: campaign._id, name: /^app showcase$/i });
  const generatedFolder = defaultFolders?.Generated || await Folder.findOne({ campaignId: campaign._id, name: /^generated$/i });

  // 2. Move remaining Hook folders under Hooks/
  const hookFolderNames = [
    'rayanahh first',
    'drawing raw',
    'kling aesthetics bg'
  ];

  for (const name of hookFolderNames) {
    const f = await Folder.findOne({ campaignId: campaign._id, name });
    if (f) {
      f.parentFolderId = hooksFolder._id;
      f.tags = Array.from(new Set([...(f.tags || []), 'hooks']));
      await f.save();
    }
  }

  // 3. Move Scheduled / Final Output folders under Generated/
  const scheduledFolderNames = [
    'Dr. Nupur Schedule',
    'Sophie Blance Schedule',
    'couple.penguin schedule video',
    'rayanahh schedule',
    'penguin.couple.app final',
    'Mintu Penguin final',
    'Cartoons final',
    'Questions_plus_promo',
    'reordered'
  ];

  for (const name of scheduledFolderNames) {
    const f = await Folder.findOne({ campaignId: campaign._id, name });
    if (f) {
      f.parentFolderId = generatedFolder._id;
      f.tags = Array.from(new Set([...(f.tags || []), 'generated', 'schedule']));
      await f.save();
    }
  }

  await mongoose.disconnect();
}

organize().catch(console.error);
