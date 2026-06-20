import 'dotenv/config';
import mongoose from 'mongoose';
import Media from '../models/Media.js';
import { deleteFile } from '../services/r2Service.js';
import { createAndUploadThumbnail, fetchMediaBuffer } from '../services/thumbnailService.js';

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
      return [key, value];
    })
);

const folderId = args.get('folderId');
const overwrite = args.get('overwrite') === 'true';
const userId = args.get('userId');
const eligibleTypes = ['image', 'video'];

const main = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

  const query = { type: { $in: eligibleTypes } };
  if (userId) query.userId = userId;
  if (folderId) query.folderId = folderId === 'root' ? null : folderId;
  if (!overwrite) {
    query.$or = [
      { thumbnailUrl: { $exists: false } },
      { thumbnailUrl: '' },
      { thumbnailUrl: null },
    ];
  }

  const mediaItems = await Media.find(query);
  let generated = 0;
  let failed = 0;

  for (const item of mediaItems) {
    try {
      if (overwrite && item.thumbnailStorageKey) {
        await deleteFile(item.thumbnailStorageKey);
      }

      const buffer = await fetchMediaBuffer(item.url);
      const thumbnail = await createAndUploadThumbnail({
        buffer,
        mediaType: item.type,
        originalName: item.name,
        baseStorageKey: item.storageKey || item._id,
      });

      if (!thumbnail) {
        console.log(`skipped ${item._id} ${item.name}`);
        continue;
      }

      item.thumbnailUrl = thumbnail.thumbnailUrl;
      item.thumbnailStorageKey = thumbnail.thumbnailStorageKey;
      item.thumbnailGeneratedAt = thumbnail.thumbnailGeneratedAt;
      await item.save();
      generated += 1;
      console.log(`generated ${item._id} ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`failed ${item._id} ${item.name}: ${error.message}`);
    }
  }

  console.log(JSON.stringify({ matched: mediaItems.length, generated, failed }, null, 2));
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
