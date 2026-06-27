import { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let r2Client = null;
const accountId = process.env.R2_ACCOUNT_ID?.trim();
const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();

const useR2 = accessKeyId && secretAccessKey && accountId;
const bucketName = (process.env.R2_BUCKET_NAME || 'tw-creator-suite').trim();
const publicBaseUrl = () => (process.env.R2_PUBLIC_URL || 'https://media.theeasypost.com').trim().replace(/\/$/, '');

if (useR2) {
  try {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
      },
    });
  } catch (error) {
    console.error('❌ Failed to initialize Cloudflare R2 client:', error.message);
  }
} else {
}

/**
 * Uploads a file buffer/stream to R2 or Local storage
 * @param {Object} fileInfo - { buffer, originalname, mimetype }
 * @returns {Promise<Object>} - { url, storageKey }
 */
export const uploadFile = async (fileInfo) => {
  const fileExtension = path.extname(fileInfo.originalname);
  const fileKey = fileInfo.storageKey || `${Date.now()}-${Math.random().toString(36).substring(2, 15)}${fileExtension}`;

  if (useR2 && r2Client) {
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
        Body: fileInfo.buffer,
        ContentType: fileInfo.mimetype,
      });

      await r2Client.send(command);

      const url = `${publicBaseUrl()}/${fileKey}`;

      return {
        url,
        storageKey: fileKey,
      };
    } catch (error) {
      console.error('❌ Cloudflare R2 upload error:', error.message);
      throw new Error(`Cloudflare R2 Upload Failed: ${error.message}`);
    }
  } else {
    // Local upload fallback
    const uploadDir = path.join(__dirname, '../../public/uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const localFilePath = path.join(uploadDir, fileKey);
    fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
    fs.writeFileSync(localFilePath, fileInfo.buffer);

    const backendUrl = process.env.BACKEND_URL || 'https://theeasypost.com';
    const url = `${backendUrl}/uploads/${fileKey}`;

    return {
      url,
      storageKey: fileKey,
    };
  }
};

export const isR2DirectUploadAvailable = () => Boolean(useR2 && r2Client);

export const createPresignedUploadUrl = async ({ storageKey, contentType }) => {
  if (!isR2DirectUploadAvailable()) {
    throw new Error('Cloudflare R2 direct upload is not configured.');
  }

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: storageKey,
    ContentType: contentType || 'application/octet-stream',
  });
  const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 15 * 60 });

  return {
    uploadUrl,
    url: getStorageUrl(storageKey),
    storageKey,
    expiresIn: 15 * 60,
  };
};

export const fileExists = async (storageKey) => {
  if (!isR2DirectUploadAvailable()) return false;

  try {
    await r2Client.send(new HeadObjectCommand({
      Bucket: bucketName,
      Key: storageKey,
    }));
    return true;
  } catch {
    return false;
  }
};

/**
 * Deletes a file from R2 or Local storage
 * @param {string} storageKey 
 */
export const deleteFile = async (storageKey) => {
  if (useR2 && r2Client) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: storageKey,
      });
      await r2Client.send(command);
    } catch (error) {
      console.error('❌ Cloudflare R2 delete error:', error.message);
    }
  } else {
    // Local delete fallback
    const uploadDir = path.join(__dirname, '../../public/uploads');
    const localFilePath = path.join(uploadDir, storageKey);
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }
  }
};

export const copyFile = async ({ fromKey, toKey, contentType }) => {
  if (!fromKey || !toKey || fromKey === toKey) return null;

  if (useR2 && r2Client) {
    const command = new CopyObjectCommand({
      Bucket: bucketName,
      CopySource: `${bucketName}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
      Key: toKey,
      ...(contentType ? { ContentType: contentType, MetadataDirective: 'REPLACE' } : {}),
    });

    await r2Client.send(command);

    return {
      url: `${publicBaseUrl()}/${toKey}`,
      storageKey: toKey,
    };
  }

  const uploadDir = path.join(__dirname, '../../public/uploads');
  const sourcePath = path.join(uploadDir, fromKey);
  const targetPath = path.join(uploadDir, toKey);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);

  const backendUrl = process.env.BACKEND_URL || 'https://theeasypost.com';
  return {
    url: `${backendUrl}/uploads/${toKey}`,
    storageKey: toKey,
  };
};

export const getStorageUrl = (storageKey) => {
  if (!storageKey) return '';
  if (useR2 && r2Client) {
    return `${publicBaseUrl()}/${storageKey}`;
  }

  const backendUrl = process.env.BACKEND_URL || 'https://theeasypost.com';
  return `${backendUrl}/uploads/${storageKey}`;
};
