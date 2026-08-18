import 'dotenv/config';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Folder from '../models/Folder.js';
import Media from '../models/Media.js';

async function fixAudio() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  // 1. Find Global Audio Folder
  const globalAudio = await Folder.findOne({ name: 'Audio', parentFolderId: null, scope: 'global' });
  if (!globalAudio) {
    throw new Error('Global Audio folder not found!');
  }
  console.log('Global Audio folder ID:', globalAudio._id);

  // 2. Ensure Global Trending songs and My own audios exist
  let trendingGlobal = await Folder.findOne({
    parentFolderId: globalAudio._id,
    name: /^trending songs$/i
  });
  if (!trendingGlobal) {
    trendingGlobal = await Folder.create({
      userId: globalAudio.userId,
      campaignId: null,
      scope: 'global',
      name: 'Trending songs',
      parentFolderId: globalAudio._id,
      kind: 'folder',
      tags: ['audio', 'trending'],
    });
  }

  let myOwnGlobal = await Folder.findOne({
    parentFolderId: globalAudio._id,
    name: /^my own audios$/i
  });
  if (!myOwnGlobal) {
    myOwnGlobal = await Folder.create({
      userId: globalAudio.userId,
      campaignId: null,
      scope: 'global',
      name: 'My own audios',
      parentFolderId: globalAudio._id,
      kind: 'folder',
      tags: ['audio', 'custom'],
    });
  }

  console.log('Global Trending songs ID:', trendingGlobal._id);
  console.log('Global My own audios ID:', myOwnGlobal._id);

  // 3. Move all platform songs (including 1.mp3) into Global Trending songs
  const trendingFileNames = [
    '1.mp3', 'Flag', 'soft.mp3', 'christmas_bells.mp3', 'country_time.mp3',
    'confess_your_love.mp3', 'dramatic_opera.mp3', 'end.mp3', 'happy_piano.mp3',
    'luxury.mp3', 'mask.mp3', 'motivational.mp3', 'miss_you.mp3', 'melodic.mp3',
    'piano_storytime.mp3', 'rich_girl.mp3', 'slow_guitar.mp3', 'talk_that_talk.mp3',
    'the_one.mp3', 'trap_heavy_beat.mp3', 'trap_instrumentals.mp3', 'fire.mp3',
    'romentic.mp3', 'love me.mp3', 'atlantis.mp3', 'the night we meet.MP3',
    'dandelions.MP3', 'back to friend.MP3', 'Ordinary.MP3', 'emotional.MP3',
    'call-cut.MP3', 'hometown.MP3', 'night changes.MP3', 'night changes full.MP3',
    'lalalaal....mp3'
  ];

  for (const name of trendingFileNames) {
    await Media.updateMany(
      { name, type: 'audio' },
      { $set: { folderId: trendingGlobal._id, scope: 'global', campaignId: null } }
    );
  }

  // Move custom audio (e.g. pinterest) into My own audios
  await Media.updateMany(
    { name: /^pinterest/i, type: 'audio' },
    { $set: { folderId: myOwnGlobal._id, scope: 'global', campaignId: null } }
  );

  // 4. Clean up any duplicate campaign-scoped Audio folders and subfolders
  const duplicateAudioFolders = await Folder.find({
    name: 'Audio',
    scope: 'campaign',
    parentFolderId: null
  });

  console.log(`Found ${duplicateAudioFolders.length} duplicate campaign-scoped Audio folders to clean up.`);
  for (const dup of duplicateAudioFolders) {
    // delete its subfolders
    await Folder.deleteMany({ parentFolderId: dup._id });
    await Folder.deleteOne({ _id: dup._id });
    console.log(`Cleaned up duplicate Audio folder ${dup._id} for campaign ${dup.campaignId}`);
  }

  // 5. Final counts
  const trendingCount = await Media.countDocuments({ folderId: trendingGlobal._id });
  const myOwnCount = await Media.countDocuments({ folderId: myOwnGlobal._id });
  console.log(`\n✓ Total tracks in 'Global Audio > Trending songs': ${trendingCount}`);
  console.log(`✓ Total tracks in 'Global Audio > My own audios': ${myOwnCount}`);

  await mongoose.disconnect();
}

fixAudio().catch(console.error);
