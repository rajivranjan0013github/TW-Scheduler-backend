import 'dotenv/config';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';
import { ensureDefaultCampaignFolders } from '../services/campaignFolderService.js';

async function organize() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const campaign = await Campaign.findOne({ name: /penguin/i });
  if (!campaign) {
    throw new Error('Penguin campaign not found!');
  }
  console.log('Found Campaign:', campaign.name, 'ID:', campaign._id);

  // 1. Ensure the 3 standard folders exist: Hooks, App Showcase, Generated
  const defaultFolders = await ensureDefaultCampaignFolders(campaign._id, campaign.createdBy);
  const hooksFolder = defaultFolders?.Hooks || await Folder.findOne({ campaignId: campaign._id, name: /^hooks$/i });
  const showcaseFolder = defaultFolders?.['App Showcase'] || await Folder.findOne({ campaignId: campaign._id, name: /^app showcase$/i });
  const generatedFolder = defaultFolders?.Generated || await Folder.findOne({ campaignId: campaign._id, name: /^generated$/i });

  console.log('📁 Hooks folder ID:', hooksFolder._id);
  console.log('📁 App Showcase folder ID:', showcaseFolder._id);
  console.log('📁 Generated folder ID:', generatedFolder._id);

  // 2. Move remaining Hook folders under Hooks/
  const hookFolderNames = [
    'rayanahh first',
    'drawing raw',
    'kling aesthetics bg'
  ];

  console.log('\n--- Nesting Hook folders under Hooks/ ---');
  for (const name of hookFolderNames) {
    const f = await Folder.findOne({ campaignId: campaign._id, name });
    if (f) {
      f.parentFolderId = hooksFolder._id;
      f.tags = Array.from(new Set([...(f.tags || []), 'hooks']));
      await f.save();
      const count = await Media.countDocuments({ folderId: f._id });
      console.log(`✓ Nested '${f.name}' under 'Hooks' (${count} clips).`);
    } else {
      console.log(`- Folder not found or already moved: ${name}`);
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

  console.log('\n--- Nesting Scheduled / Output folders under Generated/ ---');
  for (const name of scheduledFolderNames) {
    const f = await Folder.findOne({ campaignId: campaign._id, name });
    if (f) {
      f.parentFolderId = generatedFolder._id;
      f.tags = Array.from(new Set([...(f.tags || []), 'generated', 'schedule']));
      await f.save();
      const count = await Media.countDocuments({ folderId: f._id });
      console.log(`✓ Nested '${f.name}' under 'Generated' (${count} items).`);
    } else {
      console.log(`- Folder not found or already moved: ${name}`);
    }
  }

  console.log('\n=============================================');
  console.log('All folders organized successfully!');
  console.log('=============================================');

  await mongoose.disconnect();
}

organize().catch(console.error);
