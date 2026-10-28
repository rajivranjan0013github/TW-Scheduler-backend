import SocialComment from '../models/SocialComment.js';
import AutomationEvent from '../models/AutomationEvent.js';
import { getDBStatus } from '../config/db.js';
import { YOUTUBE_ENGAGEMENT_RETENTION_MS } from '../utils/engagementRetention.js';

let retentionInterval = null;

export const purgeExpiredYoutubeEngagement = async (now = new Date()) => {
  const cutoff = new Date(now.getTime() - YOUTUBE_ENGAGEMENT_RETENTION_MS);
  const results = await Promise.all([SocialComment, AutomationEvent].map(async (model) => {
    // Cover existing records too; merely adding a TTL index would leave them forever.
    const result = await model.deleteMany({
      platform: 'youtube',
      $or: [
        { youtubeDataExpiresAt: { $lte: now } },
        { youtubeDataExpiresAt: null, createdAt: { $lte: cutoff } },
        { youtubeDataExpiresAt: null, createdAt: null },
      ],
    });
    await model.updateMany(
      { platform: 'youtube', youtubeDataExpiresAt: null },
      [{ $set: { youtubeDataExpiresAt: { $add: ['$createdAt', YOUTUBE_ENGAGEMENT_RETENTION_MS] } } }],
      { updatePipeline: true, timestamps: false },
    );
    return result.deletedCount || 0;
  }));
  return results.reduce((sum, count) => sum + count, 0);
};

export const startEngagementRetention = async () => {
  if (getDBStatus()) await purgeExpiredYoutubeEngagement();
  if (retentionInterval) clearInterval(retentionInterval);
  // Privacy cleanup runs even when optional background synchronization is disabled.
  retentionInterval = setInterval(() => {
    if (!getDBStatus()) return;
    purgeExpiredYoutubeEngagement().catch((error) => {
      console.error('[Engagement retention] Cleanup failed:', error.message);
    });
  }, 60 * 60 * 1000);
  retentionInterval.unref();
};
