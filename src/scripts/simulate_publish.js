import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { publishPostJob } from '../queues/publisherWorker.js';
import ScheduledPost from '../models/ScheduledPost.js';

dotenv.config();

async function run() {
  const success = await connectDB();
  if (!success) {
    console.error('Failed to connect to DB!');
    return;
  }

  // Find the latest carousel scheduled post
  const post = await ScheduledPost.findOne({ 'platformSpecifics.type': 'carousel' }).sort({ createdAt: -1 });
  if (!post) {
    console.error('No carousel post found to publish!');
    return;
  }

  // Reset its status to 'scheduled' so it gets processed
  post.status = 'scheduled';
  await post.save();

  await publishPostJob(post._id);

  await mongoose.disconnect();
}

run().catch(console.error);
