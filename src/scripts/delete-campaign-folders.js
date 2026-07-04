import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { S3Client, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const accountId = process.env.R2_ACCOUNT_ID?.trim();
const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
const bucketName = (process.env.R2_BUCKET_NAME || 'tw-scheduler').trim();

if (!MONGODB_URI) {
  console.error("MONGODB_URI is missing");
  process.exit(1);
}

// Schemas
const Folder = mongoose.models.Folder || mongoose.model('Folder', new mongoose.Schema({}, { strict: false, collection: 'folders' }));
const Media = mongoose.models.Media || mongoose.model('Media', new mongoose.Schema({}, { strict: false, collection: 'media' }));

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

async function main() {
  await mongoose.connect(MONGODB_URI);

  const foldersToDelete = [
    { name: 'mintu', id: '6a3f5ff7c32abcb0cd69b6e3' },
    { name: 'randeep', id: '6a3f6a3bfcea6871efb73ba3' },
    { name: 'vivek', id: '6a3f63e4c32abcb0cd69ba7c' }
  ];

  for (const folder of foldersToDelete) {
    // 1. Find all media documents in the DB for this folder
    const medias = await Media.find({ folderId: new mongoose.Types.ObjectId(folder.id) });

    if (medias.length > 0) {
      // Gather all keys (original & thumbnail keys if exists)
      const keysToDelete = [];
      medias.forEach(m => {
        if (m.storageKey) keysToDelete.push({ Key: m.storageKey });
        if (m.thumbnailStorageKey) keysToDelete.push({ Key: m.thumbnailStorageKey });
      });

      if (keysToDelete.length > 0) {
        // Chunk R2 deletion in blocks of 1000 (S3 API limit)
        for (let i = 0; i < keysToDelete.length; i += 1000) {
          const chunk = keysToDelete.slice(i, i + 1000);
          try {
            await r2Client.send(new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: { Objects: chunk }
            }));
          } catch (err) {
            console.error(`  Error deleting batch from R2:`, err.message);
          }
        }
      }

      // 2. Delete media records from DB
      const mediaDeleteResult = await Media.deleteMany({ folderId: new mongoose.Types.ObjectId(folder.id) });
    }

    // 3. Prefix search safety clean (matches "users/<userId>/folders/<folderId>/")
    // Deduced from the first media key, or constructed if we can find the userId from the medias
    let userId = '6a31cf989801f82f3d1633bc'; // Default userId found from our previous search
    const firstMediaWithKey = medias.find(m => m.storageKey && m.storageKey.startsWith('users/'));
    if (firstMediaWithKey) {
      const match = firstMediaWithKey.storageKey.match(/^users\/([^/]+)\/folders/);
      if (match) userId = match[1];
    }
    
    if (userId) {
      const prefix = `users/${userId}/folders/${folder.id}/`;
      try {
        const listResult = await r2Client.send(new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix
        }));
        
        if (listResult.Contents && listResult.Contents.length > 0) {
          const r2OrphanedKeys = listResult.Contents.map(obj => ({ Key: obj.Key }));
          await r2Client.send(new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: r2OrphanedKeys }
          }));
        }
      } catch (err) {
        console.error(`  Failed to scan R2 prefix:`, err.message);
      }
    }

    // 4. Delete the folder document from DB
    const folderDeleteResult = await Folder.deleteOne({ _id: new mongoose.Types.ObjectId(folder.id) });
  }

  await mongoose.disconnect();
}

main().catch(console.error);
