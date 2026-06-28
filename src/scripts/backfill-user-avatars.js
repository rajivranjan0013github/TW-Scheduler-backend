import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { shouldStoreAvatarUrl, storeRemoteAvatarForUser } from '../services/avatarStorageService.js';

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
      return [key, value];
    })
);

const dryRun = args.get('dryRun') !== 'false';
const includeAllRemote = args.get('includeAllRemote') === 'true';

const googleAvatarPattern = /googleusercontent\.com|google\.com\/.*\/photo/i;

const avatarNeedsBackfill = (avatar) => {
  if (!avatar || typeof avatar !== 'string') return false;
  if (!shouldStoreAvatarUrl(avatar)) return false;
  if (includeAllRemote) return /^https?:\/\//i.test(avatar);
  return googleAvatarPattern.test(avatar);
};

const main = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

  const users = await User.find({
    avatar: { $exists: true, $type: 'string', $ne: '' },
  }).sort({ createdAt: 1 });

  const results = [];

  for (const user of users) {
    if (!avatarNeedsBackfill(user.avatar)) {
      continue;
    }

    const before = user.avatar;

    if (dryRun) {
      results.push({
        id: String(user._id),
        email: user.email,
        status: 'would_update',
        from: before,
      });
      continue;
    }

    const storedAvatar = await storeRemoteAvatarForUser(user, before);
    const updated = storedAvatar && storedAvatar !== before;

    results.push({
      id: String(user._id),
      email: user.email,
      status: updated ? 'updated' : 'unchanged',
      from: before,
      to: storedAvatar,
    });
  }

  console.log(JSON.stringify({
    dryRun,
    includeAllRemote,
    scanned: users.length,
    matched: results.length,
    updated: results.filter((item) => item.status === 'updated').length,
    unchanged: results.filter((item) => item.status === 'unchanged').length,
    samples: results.slice(0, 10),
  }, null, 2));

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
