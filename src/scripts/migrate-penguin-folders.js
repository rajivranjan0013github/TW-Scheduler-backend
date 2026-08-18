import 'dotenv/config';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const campaign = await Campaign.findOne({ name: /penguin/i });
  if (!campaign) {
    throw new Error('Penguin campaign not found!');
  }
  console.log('Found Campaign:', campaign.name, 'ID:', campaign._id);

  // 1. Ensure Hooks & App Showcase folders exist
  let hooksFolder = await Folder.findOne({ campaignId: campaign._id, name: /^hooks$/i });
  if (!hooksFolder) {
    hooksFolder = await Folder.create({
      userId: campaign.createdBy,
      campaignId: campaign._id,
      name: 'Hooks',
      scope: 'campaign',
      parentFolderId: null,
      kind: 'folder',
      tags: ['hooks'],
    });
    console.log('Created Hooks folder:', hooksFolder._id);
  } else {
    console.log('Found Hooks folder:', hooksFolder._id);
  }

  let showcaseFolder = await Folder.findOne({ campaignId: campaign._id, name: /^app showcase$/i });
  if (!showcaseFolder) {
    showcaseFolder = await Folder.create({
      userId: campaign.createdBy,
      campaignId: campaign._id,
      name: 'App Showcase',
      scope: 'campaign',
      parentFolderId: null,
      kind: 'folder',
      tags: ['app-showcase', 'promo'],
    });
    console.log('Created App Showcase folder:', showcaseFolder._id);
  } else {
    console.log('Found App Showcase folder:', showcaseFolder._id);
  }

  // 2. Set campaign promoFolderId to App Showcase
  campaign.promoFolderId = showcaseFolder._id;
  await campaign.save();
  console.log('Set campaign.promoFolderId -> App Showcase (', showcaseFolder._id, ')');

  // 3. Move media files from 'Penguin Promo Video' into 'App Showcase'
  const promoFolder = await Folder.findOne({ campaignId: campaign._id, name: 'Penguin Promo Video' });
  if (promoFolder) {
    const updateResult = await Media.updateMany(
      { folderId: promoFolder._id },
      { $set: { folderId: showcaseFolder._id } }
    );
    console.log(`Moved ${updateResult.modifiedCount} media items from 'Penguin Promo Video' into 'App Showcase'.`);
    await Folder.deleteOne({ _id: promoFolder._id });
    console.log(`Deleted old empty 'Penguin Promo Video' folder.`);
  }

  // 4. Move hook folders into 'Hooks' as subfolders (parentFolderId = hooksFolder._id)
  const hookFolderNames = [
    'couple.penguin First',
    'Dr Nupur first',
    'Sophie Blance',
    'Cartoons',
    'Questions_Bg'
  ];

  for (const name of hookFolderNames) {
    const f = await Folder.findOne({ campaignId: campaign._id, name });
    if (f) {
      f.parentFolderId = hooksFolder._id;
      f.tags = Array.from(new Set([...(f.tags || []), 'hooks']));
      await f.save();
      const count = await Media.countDocuments({ folderId: f._id });
      console.log(`Nested '${f.name}' under 'Hooks' (${count} clips).`);
    }
  }

  console.log('\nMigration successfully completed!');
  await mongoose.disconnect();
}

migrate().catch(console.error);
