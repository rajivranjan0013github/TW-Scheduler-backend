import 'dotenv/config';
import mongoose from 'mongoose';
import Media from '../models/Media.js';

// Media saved without batch fields (video editor, carousel sets, folder covers,
// older records) sorts below every batch upload. Use createdAt as its batch time.

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
      return [key, value];
    })
);

const dryRun = args.get('dryRun') === 'true';

const main = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

  const missingBatchQuery = { uploadBatchCreatedAt: { $in: [null] } };
  const missingOrderQuery = { uploadOrder: { $in: [null] } };

  const [missingBatch, missingOrder] = await Promise.all([
    Media.countDocuments(missingBatchQuery),
    Media.countDocuments(missingOrderQuery),
  ]);

  console.log(`Media missing uploadBatchCreatedAt: ${missingBatch}`);
  console.log(`Media missing uploadOrder: ${missingOrder}`);

  if (dryRun) {
    const samples = await Media.find(missingBatchQuery)
      .select('_id name type createdAt')
      .limit(5)
      .lean();
    console.log('Dry run, no changes written. Samples:', samples);
    return;
  }

  const batchResult = await Media.updateMany(
    missingBatchQuery,
    [{ $set: { uploadBatchCreatedAt: { $ifNull: ['$createdAt', '$$NOW'] } } }],
    { updatePipeline: true },
  );
  const orderResult = await Media.updateMany(
    missingOrderQuery,
    { $set: { uploadOrder: 0 } },
  );

  console.log(`Updated uploadBatchCreatedAt on ${batchResult.modifiedCount} media`);
  console.log(`Updated uploadOrder on ${orderResult.modifiedCount} media`);
};

main()
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
