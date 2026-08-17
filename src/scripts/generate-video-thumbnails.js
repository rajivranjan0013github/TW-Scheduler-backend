import 'dotenv/config';
import mongoose from 'mongoose';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Media from '../models/Media.js';
import { uploadFile } from '../services/r2Service.js';
import { getThumbnailStorageKey } from '../utils/storageKeys.js';

const execAsync = promisify(exec);

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  })
);

const targetCampaignId = args.get('campaignId') || '6a3702c2771c89e7e9a29f79';
const processAll = args.get('all') === 'true';
const concurrency = parseInt(args.get('concurrency') || '6', 10);

async function generateThumbnailForMedia(media) {
  const tmpJpg = path.join(os.tmpdir(), `thumb_${media._id}_${Date.now()}.jpg`);
  try {
    const videoUrl = media.url;
    if (!videoUrl) {
      throw new Error('Video URL is missing');
    }

    // Extract frame at 0.5s or start of video with scale
    const cmd = `ffmpeg -y -ss 00:00:00.500 -i "${videoUrl}" -frames:v 1 -vf "scale=480:-1" -q:v 4 "${tmpJpg}"`;
    await execAsync(cmd);

    if (!fs.existsSync(tmpJpg)) {
      // Fallback: try extracting from beginning (0s)
      const fallbackCmd = `ffmpeg -y -ss 00:00:00.000 -i "${videoUrl}" -frames:v 1 -vf "scale=480:-1" -q:v 4 "${tmpJpg}"`;
      await execAsync(fallbackCmd);
    }

    if (!fs.existsSync(tmpJpg)) {
      throw new Error('Failed to generate thumbnail file');
    }

    const buffer = fs.readFileSync(tmpJpg);
    const thumbKey = getThumbnailStorageKey({
      userId: media.userId,
      folderId: media.folderId,
      mediaId: media._id,
    });

    const uploaded = await uploadFile({
      buffer,
      originalname: 'thumbnail.jpg',
      mimetype: 'image/jpeg',
      storageKey: thumbKey,
    });

    await Media.updateOne(
      { _id: media._id },
      {
        $set: {
          thumbnailUrl: uploaded.url,
          thumbnailStorageKey: uploaded.storageKey,
          thumbnailGeneratedAt: new Date(),
        },
      }
    );

    return { success: true, id: media._id, name: media.name };
  } catch (err) {
    return { success: false, id: media._id, name: media.name, error: err.message };
  } finally {
    if (fs.existsSync(tmpJpg)) {
      try {
        fs.unlinkSync(tmpJpg);
      } catch (_) {}
    }
  }
}

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is not defined in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const query = {
    type: 'video',
    $or: [
      { thumbnailUrl: { $exists: false } },
      { thumbnailUrl: null },
      { thumbnailUrl: '' },
    ],
  };

  if (!processAll && targetCampaignId) {
    query.campaignId = targetCampaignId;
  }

  const mediaList = await Media.find(query).lean();
  console.log(`Found ${mediaList.length} videos without thumbnails to process...`);

  if (mediaList.length === 0) {
    console.log('No videos missing thumbnails.');
    await mongoose.disconnect();
    return;
  }

  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  const total = mediaList.length;

  console.log(`Starting thumbnail generation (Concurrency: ${concurrency})...`);

  for (let i = 0; i < total; i += concurrency) {
    const chunk = mediaList.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(generateThumbnailForMedia));

    for (const res of results) {
      completed++;
      if (res.success) {
        succeeded++;
        console.log(`[${completed}/${total}] ✅ Generated thumbnail for: ${res.name} (${res.id})`);
      } else {
        failed++;
        console.error(`[${completed}/${total}] ❌ Failed for: ${res.name} (${res.id}) - ${res.error}`);
      }
    }
  }

  console.log('\n--- Thumbnail Generation Complete ---');
  console.log(`Total: ${total}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
