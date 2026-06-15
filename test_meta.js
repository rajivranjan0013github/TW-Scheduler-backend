import 'dotenv/config';
import { publishToInstagram, publishToFacebook } from './src/services/metaService.js';

const accessToken = process.env.TEST_META_ACCESS_TOKEN;
const targetId = process.env.TEST_META_TARGET_ID;
const platform = process.env.TEST_META_PLATFORM || 'instagram'; // 'instagram' or 'facebook'
const mediaUrl = process.env.TEST_MEDIA_URL || 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800'; // Default beautiful beach image
const mediaType = process.env.TEST_MEDIA_TYPE || 'image'; // 'image' or 'video'
const caption = process.env.TEST_CAPTION || 'Hello world from TW Scheduler actual Meta API! 🚀🌅';

console.log('--- Meta API Direct Publisher Test ---');
console.log(`- Platform: ${platform.toUpperCase()}`);
console.log(`- Target Account/Page ID: ${targetId}`);
console.log(`- Media URL: ${mediaUrl}`);
console.log(`- Media Type: ${mediaType}`);
console.log(`- Caption: ${caption}`);
console.log(`- Access Token Loaded: ${accessToken ? 'YES (length: ' + accessToken.length + ')' : 'NO'}`);

if (!accessToken || !targetId) {
  console.error('\n❌ ERROR: Please define TEST_META_ACCESS_TOKEN and TEST_META_TARGET_ID in your .env file to run this test.');
  process.exit(1);
}

async function startTest() {
  try {
    let resultId = null;
    if (platform === 'instagram') {
      console.log('\n⏳ Initiating Instagram Content Publishing sequence (Container -> Poll -> Publish)...');
      resultId = await publishToInstagram(accessToken, targetId, mediaUrl, mediaType, caption);
    } else if (platform === 'facebook') {
      console.log('\n⏳ Initiating Facebook Page Publishing sequence...');
      resultId = await publishToFacebook(accessToken, targetId, mediaUrl, mediaType, caption);
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    console.log(`\n✅ SUCCESS! Post successfully created on Meta. ID: ${resultId}`);
    process.exit(0);
  } catch (error) {
    console.error('\n❌ TEST PUBLISHING FAILED:', error.message);
    process.exit(1);
  }
}

startTest();
