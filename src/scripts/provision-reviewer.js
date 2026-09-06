import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import User from '../models/User.js';

const email = String(process.env.REVIEWER_EMAIL || '').trim().toLowerCase();
const password = String(process.env.REVIEWER_PASSWORD || '');
const name = String(process.env.REVIEWER_NAME || 'Platform App Reviewer').trim();

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
if (!email || !email.includes('@')) throw new Error('Set a valid REVIEWER_EMAIL for this one-time command.');
if (password.length < 14) throw new Error('REVIEWER_PASSWORD must contain at least 14 characters.');

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
try {
  const hashedPassword = await bcrypt.hash(password, 12);
  const reviewer = await User.findOneAndUpdate(
    { email },
    {
      $set: {
        name,
        password: hashedPassword,
        role: 'editor',
        userType: 'account_handler',
      },
    },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  );

  const storedReviewer = await User.findById(reviewer._id).select('+password');
  if (!storedReviewer?.password || !(await bcrypt.compare(password, storedReviewer.password))) {
    throw new Error('Reviewer account was not provisioned with the configured password.');
  }
  console.info(`Reviewer account provisioned: ${reviewer.email}`);
} finally {
  await mongoose.disconnect();
}
