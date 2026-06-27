import 'dotenv/config';
import mongoose from 'mongoose';
import Media from '../models/Media.js';
import { getStorageUrl } from '../services/r2Service.js';

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
      return [key, value];
    })
);

const dryRun = args.get('dryRun') === 'true';
const oldBaseUrl = (args.get('oldBaseUrl') || process.env.OLD_R2_PUBLIC_URL || '').replace(/\/$/, '');
const nextBaseUrl = (args.get('nextBaseUrl') || process.env.R2_PUBLIC_URL || 'https://media.theeasypost.com').replace(/\/$/, '');

const replaceBaseUrl = (value) => {
  if (!value || typeof value !== 'string') return value;
  if (!value.startsWith(`${oldBaseUrl}/`)) return value;
  return `${nextBaseUrl}${value.slice(oldBaseUrl.length)}`;
};

const main = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }
  if (!oldBaseUrl) {
    throw new Error('oldBaseUrl or OLD_R2_PUBLIC_URL is required');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

  const mediaItems = await Media.find({
    $or: [
      { url: { $regex: `^${oldBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/` } },
      { thumbnailUrl: { $regex: `^${oldBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/` } },
    ],
  });

  let updated = 0;
  const samples = [];

  for (const item of mediaItems) {
    const nextUrl = item.storageKey ? getStorageUrl(item.storageKey) : replaceBaseUrl(item.url);
    const nextThumbnailUrl = item.thumbnailStorageKey
      ? getStorageUrl(item.thumbnailStorageKey)
      : replaceBaseUrl(item.thumbnailUrl);

    const changed = nextUrl !== item.url || nextThumbnailUrl !== item.thumbnailUrl;
    if (!changed) continue;

    if (samples.length < 5) {
      samples.push({
        id: String(item._id),
        from: item.url,
        to: nextUrl,
        thumbnailFrom: item.thumbnailUrl,
        thumbnailTo: nextThumbnailUrl,
      });
    }

    if (!dryRun) {
      item.url = nextUrl;
      item.thumbnailUrl = nextThumbnailUrl;
      await item.save();
    }

    updated += 1;
  }

  console.log(JSON.stringify({
    dryRun,
    oldBaseUrl,
    nextBaseUrl,
    matched: mediaItems.length,
    updated,
    samples,
  }, null, 2));

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
