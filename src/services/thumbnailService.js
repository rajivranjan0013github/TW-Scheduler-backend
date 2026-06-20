import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { uploadFile } from './r2Service.js';

const THUMBNAIL_WIDTH = 360;
const THUMBNAIL_QUALITY = 9;

const getExtensionForType = (mediaType) => {
  if (mediaType === 'image') return '.image';
  if (mediaType === 'video') return '.video';
  return '.media';
};

const runFfmpeg = (args) => new Promise((resolve, reject) => {
  if (!ffmpegPath) {
    reject(new Error('ffmpeg binary is not available'));
    return;
  }

  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
  });
});

const writeTempInput = async ({ buffer, mediaType, originalName }) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-thumb-'));
  const extension = path.extname(originalName || '') || getExtensionForType(mediaType);
  const inputPath = path.join(tempDir, `source${extension}`);
  const outputPath = path.join(tempDir, 'thumbnail.jpg');
  await fs.writeFile(inputPath, buffer);
  return { tempDir, inputPath, outputPath };
};

const createThumbnailBuffer = async ({ buffer, mediaType, originalName }) => {
  if (!['image', 'video'].includes(mediaType) || !buffer?.length) return null;

  const { tempDir, inputPath, outputPath } = await writeTempInput({ buffer, mediaType, originalName });

  try {
    const seekArgs = mediaType === 'video' ? ['-ss', '00:00:00.500'] : [];
    await runFfmpeg([
      '-y',
      ...seekArgs,
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', `scale=${THUMBNAIL_WIDTH}:-2`,
      '-q:v', String(THUMBNAIL_QUALITY),
      outputPath,
    ]);

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

export const createAndUploadThumbnail = async ({ buffer, mediaType, originalName, baseStorageKey, thumbnailStorageKey }) => {
  try {
    const thumbnailBuffer = await createThumbnailBuffer({ buffer, mediaType, originalName });
    if (!thumbnailBuffer) return null;

    const safeBaseKey = String(baseStorageKey || `${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .replace(/\.[^/.]+$/, '');
    const resolvedThumbnailStorageKey = thumbnailStorageKey || `thumbnails/${safeBaseKey}.jpg`;

    const uploaded = await uploadFile({
      buffer: thumbnailBuffer,
      originalname: `${safeBaseKey}.jpg`,
      mimetype: 'image/jpeg',
      storageKey: resolvedThumbnailStorageKey,
    });

    return {
      thumbnailUrl: uploaded.url,
      thumbnailStorageKey: uploaded.storageKey,
      thumbnailGeneratedAt: new Date(),
    };
  } catch (error) {
    console.error('Thumbnail generation failed:', error.message);
    return null;
  }
};

export const fetchMediaBuffer = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media for thumbnail: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
};
