/**
 * Debug script to check accounts and test Meta comment fetching
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import SocialAccount from '../models/SocialAccount.js';

const MONGODB_URI = process.env.MONGODB_URI;

const debug = async () => {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('🔌 Connected to MongoDB.\n');

    const accounts = await SocialAccount.find();
    console.log(`📋 Found ${accounts.length} social accounts:\n`);

    for (const acc of accounts) {
      console.log(`--- ${acc.platform.toUpperCase()} | ${acc.name} ---`);
      console.log(`  accountId: ${acc.accountId}`);
      console.log(`  authProvider: ${acc.authProvider}`);
      console.log(`  userId: ${acc.userId}`);
      console.log(`  isConnected: ${acc.isConnected}`);
      console.log(`  tokenPrefix: ${acc.accessToken?.substring(0, 20)}...`);
      console.log(`  tokenLength: ${acc.accessToken?.length}`);
      console.log(`  isMock: ${acc.accessToken?.startsWith('mock-')}`);

      // Test: try to fetch posts
      const graphHost = (acc.platform === 'instagram' && acc.authProvider === 'instagram') 
        ? 'graph.instagram.com' 
        : 'graph.facebook.com';

      let postsUrl;
      if (acc.platform === 'instagram') {
        postsUrl = `https://${graphHost}/v20.0/${acc.accountId}/media?fields=id,caption,timestamp&limit=3&access_token=${acc.accessToken}`;
      } else {
        postsUrl = `https://graph.facebook.com/v20.0/${acc.accountId}/published_posts?fields=id,message,created_time&limit=3&access_token=${acc.accessToken}`;
      }

      console.log(`  🔗 Testing posts fetch (${graphHost})...`);
      try {
        const res = await fetch(postsUrl);
        const data = await res.json();
        
        if (res.ok && data.data) {
          console.log(`  ✅ Got ${data.data.length} posts`);
          
          // Try fetching comments for the first post
          if (data.data.length > 0) {
            const firstPost = data.data[0];
            console.log(`  📝 First post: "${(firstPost.caption || firstPost.message || '').substring(0, 50)}..."`);
            
            let commentsUrl;
            if (acc.platform === 'instagram') {
              commentsUrl = `https://${graphHost}/v20.0/${firstPost.id}/comments?fields=id,text,username,timestamp&access_token=${acc.accessToken}`;
            } else {
              commentsUrl = `https://graph.facebook.com/v20.0/${firstPost.id}/comments?fields=id,message,from,created_time&access_token=${acc.accessToken}`;
            }

            const commRes = await fetch(commentsUrl);
            const commData = await commRes.json();
            
            if (commRes.ok) {
              console.log(`  💬 Got ${commData.data?.length || 0} comments on first post`);
              if (commData.data?.length > 0) {
                console.log(`  First comment: "${commData.data[0].text || commData.data[0].message}"`);
              }
            } else {
              console.log(`  ❌ Comments fetch failed:`, commData.error?.message);
              console.log(`  Error code: ${commData.error?.code}, type: ${commData.error?.type}`);
            }
          }
        } else {
          console.log(`  ❌ Posts fetch failed:`, data.error?.message);
          console.log(`  Error code: ${data.error?.code}, type: ${data.error?.type}`);
        }
      } catch (err) {
        console.log(`  ❌ Network error:`, err.message);
      }

      console.log('');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
};

debug();
