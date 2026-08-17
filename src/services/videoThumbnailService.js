import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Media from '../models/Media.js';
import { uploadFile, fileExists, getStorageUrl } from './r2Service.js';
import { getThumbnailStorageKey } from '../utils/storageKeys.js';

const execAsync = promisify(exec);

/**
 * Extracts a thumbnail from a video URL, uploads to R2, and returns storage details.
 */
export const generateThumbnailFromUrl = async ({ videoUrl, userId, folderId, mediaId }) => {
  if (!videoUrl) return null;

  const tmpJpg = path.join(os.tmpdir(), `thumb_${mediaId}_${Date.now()}.jpg`);
  try {
    const cmd = `ffmpeg -y -ss 00:00:00.500 -i "${videoUrl}" -frames:v 1 -vf "scale=480:-1" -q:v 4 "${tmpJpg}"`;
    try {
      await execAsync(cmd);
    } catch (_) {
      // Fallback to start of video
      const fallbackCmd = `ffmpeg -y -ss 00:00:00.000 -i "${videoUrl}" -frames:v 1 -vf "scale=480:-1" -q:v 4 "${tmpJpg}"`;
      await execAsync(fallbackCmd);
    }

    if (!fs.existsSync(tmpJpg)) {
      return null;
    }

    const buffer = fs.readFileSync(tmpJpg);
    const thumbKey = getThumbnailStorageKey({
      userId,
      folderId,
      mediaId,
    });

    const uploaded = await uploadFile({
      buffer,
      originalname: 'thumbnail.jpg',
      mimetype: 'image/jpeg',
      storageKey: thumbKey,
    });

    return {
      thumbnailUrl: uploaded.url,
      thumbnailStorageKey: uploaded.storageKey,
      thumbnailGeneratedAt: new Date(),
    };
  } catch (error) {
    console.error(`[ThumbnailService] Error generating thumbnail for media ${mediaId}:`, error.message);
    return null;
  } finally {
    if (fs.existsSync(tmpJpg)) {
      try {
        fs.unlinkSync(tmpJpg);
      } catch (_) {}
    }
  }
};

/**
 * Extracts a thumbnail from a local video buffer/file, uploads to R2, and returns storage details.
 */
export const generateThumbnailFromBuffer = async ({ buffer: videoBuffer, extension = '.mp4', userId, folderId, mediaId }) => {
  if (!videoBuffer) return null;

  const tmpVideo = path.join(os.tmpdir(), `vid_${mediaId}_${Date.now()}${extension}`);
  const tmpJpg = path.join(os.tmpdir(), `thumb_${mediaId}_${Date.now()}.jpg`);

  try {
    fs.writeFileSync(tmpVideo, videoBuffer);

    const cmd = `ffmpeg -y -ss 00:00:00.500 -i "${tmpVideo}" -frames:v 1 -vf "scale=480:-1" -q:v 4 "${tmpJpg}"`;
    try {
      await execAsync(cmd);
    } catch (_) {
      const fallbackCmd = `ffmpeg -y -ss 00:00:00.000 -i "${tmpVideo}" -frames:v 1 -vf "scale=480:-1" -q:v 4 "${tmpJpg}"`;
      await execAsync(fallbackCmd);
    }

    if (!fs.existsSync(tmpJpg)) {
      return null;
    }

    const thumbBuffer = fs.readFileSync(tmpJpg);
    const thumbKey = getThumbnailStorageKey({
      userId,
      folderId,
      mediaId,
    });

    const uploaded = await uploadFile({
      buffer: thumbBuffer,
      originalname: 'thumbnail.jpg',
      mimetype: 'image/jpeg',
      storageKey: thumbKey,
    });

    return {
      thumbnailUrl: uploaded.url,
      thumbnailStorageKey: uploaded.storageKey,
      thumbnailGeneratedAt: new Date(),
    };
  } catch (error) {
    console.error(`[ThumbnailService] Error generating thumbnail from buffer for media ${mediaId}:`, error.message);
    return null;
  } finally {
    if (fs.existsSync(tmpVideo)) {
      try { fs.unlinkSync(tmpVideo); } catch (_) {}
    }
    if (fs.existsSync(tmpJpg)) {
      try { fs.unlinkSync(tmpJpg); } catch (_) {}
    }
  }
};

/**
 * Asynchronously ensures a Media document has a thumbnail. If not, generates and saves it in MongoDB.
 */
export const ensureMediaThumbnail = async (mediaId) => {
  try {
    const media = await Media.findById(mediaId);
    if (!media || media.type !== 'video') return;
    if (media.thumbnailUrl && media.thumbnailStorageKey) return;

    // Check if thumbnail already exists in R2
    const expectedThumbKey = getThumbnailStorageKey({
      userId: media.userId,
      folderId: media.folderId,
      mediaId: media._id,
    });

    const exists = await fileExists(expectedThumbKey);
    if (exists) {
      media.thumbnailStorageKey = expectedThumbKey;
      media.thumbnailUrl = getStorageUrl(expectedThumbKey);
      media.thumbnailGeneratedAt = new Date();
      await media.save();
      return;
    }

    // Otherwise generate from URL
    const result = await generateThumbnailFromUrl({
      videoUrl: media.url,
      userId: media.userId,
      folderId: media.folderId,
      mediaId: media._id,
    });

    if (result) {
      media.thumbnailUrl = result.thumbnailUrl;
      media.thumbnailStorageKey = result.thumbnailStorageKey;
      media.thumbnailGeneratedAt = result.thumbnailGeneratedAt;
      await media.save();
    }
  } catch (error) {
    console.error(`[ThumbnailService] Failed to ensure thumbnail for ${mediaId}:`, error.message);
  }
};
