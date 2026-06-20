import 'dotenv/config';
import mongoose from 'mongoose';
import path from 'path';
import Media from '../models/Media.js';
import { copyFile, deleteFile, getStorageUrl } from '../services/r2Service.js';
import { getOriginalStorageKey, getThumbnailStorageKey, isStructuredMediaKey } from '../utils/storageKeys.js';

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
      return [key, value];
    })
);

const dryRun = args.get('dryRun') === 'true';
const deleteOld = args.get('deleteOld') === 'true';
const userId = args.get('userId');
const folderId = args.get('folderId');

const mediaNeedsMigration = (item) => (
  item.storageKey && !isStructuredMediaKey(item.storageKey)
);

const thumbnailNeedsMigration = (item, nextThumbnailKey) => (
  item.thumbnailStorageKey && item.thumbnailStorageKey !== nextThumbnailKey
);

const getContentType = (item) => {
  const extension = path.extname(item.name || item.storageKey || '').toLowerCase();
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.mp3') return 'audio/mpeg';
  if (item.type === 'video') return 'video/mp4';
  if (item.type === 'image') return 'image/jpeg';
  if (item.type === 'audio') return 'audio/mpeg';
  return undefined;
};

const main = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

  const query = {};
  if (userId) query.userId = userId;
  if (folderId) query.folderId = folderId === 'root' ? null : folderId;

  const mediaItems = await Media.find(query);
  const results = [];

  for (const item of mediaItems) {
    const nextStorageKey = getOriginalStorageKey({
      userId: item.userId,
      folderId: item.folderId,
      mediaId: item._id,
      originalName: item.name,
    });
    const nextThumbnailKey = getThumbnailStorageKey({
      userId: item.userId,
      folderId: item.folderId,
      mediaId: item._id,
    });

    const moveOriginal = mediaNeedsMigration(item);
    const moveThumbnail = thumbnailNeedsMigration(item, nextThumbnailKey);

    if (!moveOriginal && !moveThumbnail) {
      results.push({ id: String(item._id), status: 'already_structured' });
      continue;
    }

    if (dryRun) {
      results.push({
        id: String(item._id),
        status: 'would_migrate',
        from: item.storageKey,
        to: nextStorageKey,
        thumbnailFrom: item.thumbnailStorageKey,
        thumbnailTo: nextThumbnailKey,
      });
      continue;
    }

    try {
      const oldStorageKey = item.storageKey;
      const oldThumbnailStorageKey = item.thumbnailStorageKey;

      if (moveOriginal) {
        await copyFile({
          fromKey: item.storageKey,
          toKey: nextStorageKey,
          contentType: getContentType(item),
        });
        item.storageKey = nextStorageKey;
        item.url = getStorageUrl(nextStorageKey);
      }

      if (moveThumbnail) {
        await copyFile({
          fromKey: item.thumbnailStorageKey,
          toKey: nextThumbnailKey,
          contentType: 'image/jpeg',
        });
        item.thumbnailStorageKey = nextThumbnailKey;
        item.thumbnailUrl = getStorageUrl(nextThumbnailKey);
      }

      await item.save();

      if (deleteOld) {
        if (moveOriginal && oldStorageKey) await deleteFile(oldStorageKey);
        if (moveThumbnail && oldThumbnailStorageKey) await deleteFile(oldThumbnailStorageKey);
      }

      results.push({ id: String(item._id), status: 'migrated' });
    } catch (error) {
      results.push({ id: String(item._id), status: 'failed', message: error.message });
    }
  }

  const summary = {
    matched: mediaItems.length,
    migrated: results.filter((item) => item.status === 'migrated').length,
    alreadyStructured: results.filter((item) => item.status === 'already_structured').length,
    failed: results.filter((item) => item.status === 'failed').length,
    dryRun,
    deleteOld,
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
