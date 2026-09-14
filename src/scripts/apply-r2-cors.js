import 'dotenv/config';
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

const accountId = process.env.R2_ACCOUNT_ID?.trim();
const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
const bucketName = (process.env.R2_BUCKET_NAME || 'tw-creator-suite').trim();

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('❌ Missing R2 credentials in environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  process.exit(1);
}

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

async function main() {
  console.log(`Setting CORS policy for bucket: ${bucketName}...`);

  const corsRules = [
    {
      AllowedOrigins: [
        'https://thousandpost.com',
        'https://www.thousandpost.com',
        'http://localhost:5173',
        '*',
      ],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'Accept-Ranges'],
      MaxAgeSeconds: 86400,
    },
  ];

  try {
    const putCommand = new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: corsRules,
      },
    });

    await r2Client.send(putCommand);
    console.log('✅ Successfully applied CORS policy to R2 bucket!');

    const getCommand = new GetBucketCorsCommand({ Bucket: bucketName });
    const response = await r2Client.send(getCommand);
    console.log('Current R2 Bucket CORS Rules:', JSON.stringify(response.CORSRules, null, 2));
  } catch (error) {
    console.error('❌ Error configuring R2 CORS:', error.message);
  }
}

main();
