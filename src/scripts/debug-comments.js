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

    const accounts = await SocialAccount.find();

    for (const acc of accounts) {
    

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

      try {
        const res = await fetch(postsUrl);
        const data = await res.json();
        
        if (res.ok && data.data) {
          
          // Try fetching comments for the first post
          if (data.data.length > 0) {
            const firstPost = data.data[0];
            
            let commentsUrl;
            if (acc.platform === 'instagram') {
              commentsUrl = `https://${graphHost}/v20.0/${firstPost.id}/comments?fields=id,text,username,timestamp&access_token=${acc.accessToken}`;
            } else {
              commentsUrl = `https://graph.facebook.com/v20.0/${firstPost.id}/comments?fields=id,message,from,created_time&access_token=${acc.accessToken}`;
            }

            const commRes = await fetch(commentsUrl);
            const commData = await commRes.json();
            
            if (commRes.ok) {
              if (commData.data?.length > 0) {
              }
            } else {
             
            }
          }
        } else {
        }
      } catch (err) {
      }

    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
};

debug();
