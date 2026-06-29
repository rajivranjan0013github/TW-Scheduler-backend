import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const MediaSchema = new mongoose.Schema({
  name: String,
  type: String,
  url: String,
  folderId: mongoose.Schema.Types.ObjectId
});
const Media = mongoose.model('Media', MediaSchema);

const ScheduledPostSchema = new mongoose.Schema({
  mediaIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Media' }],
  platformSpecifics: mongoose.Schema.Types.Mixed,
  status: String,
  caption: String,
  scheduledAt: Date,
  publishResponseId: String,
  publishError: String
}, { timestamps: true });

const ScheduledPost = mongoose.model('ScheduledPost', ScheduledPostSchema);

async function run() {
  const uri = process.env.MONGODB_URI;
  console.log('Connecting to Mongo...');
  await mongoose.connect(uri);
  console.log('Connected!');

  const posts = await ScheduledPost.find().sort({ createdAt: -1 }).limit(1).populate('mediaIds');
  console.log(`Found ${posts.length} posts:`);
  for (const post of posts) {
    console.log('--------------------------------------------------');
    console.log('Post ID:', post._id);
    console.log('Status:', post.status);
    console.log('Media files populated:', post.mediaIds.length);
    post.mediaIds.forEach((media, idx) => {
      console.log(`  Slide ${idx + 1}: ID=${media._id}, Name="${media.name}", Type="${media.type}", Url="${media.url}"`);
    });
  }

  await mongoose.disconnect();
}

run().catch(console.error);
