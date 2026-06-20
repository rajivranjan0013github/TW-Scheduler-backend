import { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
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

      const publicBaseUrl = (process.env.R2_PUBLIC_URL || `https://${bucketName}.r2.cloudflarestorage.com`).trim();
      const url = `${publicBaseUrl.replace(/\/$/, '')}/${fileKey}`;

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

    const port = process.env.PORT || 5001;
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${port}`;
    const url = `${backendUrl}/uploads/${fileKey}`;

    return {
      url,
      storageKey: fileKey,
    };
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

    const publicBaseUrl = (process.env.R2_PUBLIC_URL || `https://${bucketName}.r2.cloudflarestorage.com`).trim();
    return {
      url: `${publicBaseUrl.replace(/\/$/, '')}/${toKey}`,
      storageKey: toKey,
    };
  }

  const uploadDir = path.join(__dirname, '../../public/uploads');
  const sourcePath = path.join(uploadDir, fromKey);
  const targetPath = path.join(uploadDir, toKey);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);

  const port = process.env.PORT || 5001;
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${port}`;
  return {
    url: `${backendUrl}/uploads/${toKey}`,
    storageKey: toKey,
  };
};

export const getStorageUrl = (storageKey) => {
  if (!storageKey) return '';
  if (useR2 && r2Client) {
    const publicBaseUrl = (process.env.R2_PUBLIC_URL || `https://${bucketName}.r2.cloudflarestorage.com`).trim();
    return `${publicBaseUrl.replace(/\/$/, '')}/${storageKey}`;
  }

  const port = process.env.PORT || 5001;
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${port}`;
  return `${backendUrl}/uploads/${storageKey}`;
};
