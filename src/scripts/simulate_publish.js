import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { publishPostJob } from '../queues/publisherWorker.js';
import ScheduledPost from '../models/ScheduledPost.js';

dotenv.config();

async function run() {
  console.log('Connecting to Mongo via connectDB...');
  const success = await connectDB();
  if (!success) {
    console.error('Failed to connect to DB!');
    return;
  }
  console.log('Connected!');

  // Find the latest carousel scheduled post
  const post = await ScheduledPost.findOne({ 'platformSpecifics.type': 'carousel' }).sort({ createdAt: -1 });
  if (!post) {
    console.error('No carousel post found to publish!');
    return;
  }

  console.log('Found carousel post:', post._id);
  // Reset its status to 'scheduled' so it gets processed
  post.status = 'scheduled';
  await post.save();

  console.log('Simulating publishPostJob...');
  await publishPostJob(post._id);
  console.log('Done publishing!');

  await mongoose.disconnect();
}

run().catch(console.error);
