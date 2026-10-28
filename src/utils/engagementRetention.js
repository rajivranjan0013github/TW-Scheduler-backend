export const YOUTUBE_ENGAGEMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Expiry is based on collection time, not subsequent reads or status updates.
export const youtubeEngagementExpiry = (platform, now = new Date()) => (
  platform === 'youtube'
    ? { youtubeDataExpiresAt: new Date(now.getTime() + YOUTUBE_ENGAGEMENT_RETENTION_MS) }
    : {}
);

// Do not serve expired data while MongoDB's asynchronous TTL cleanup catches up.
export const visibleEngagementFilter = (now = new Date()) => ({
  $or: [
    { platform: { $ne: 'youtube' } },
    { youtubeDataExpiresAt: { $gt: now } },
    {
      youtubeDataExpiresAt: { $exists: false },
      createdAt: { $gt: new Date(now.getTime() - YOUTUBE_ENGAGEMENT_RETENTION_MS) },
    },
  ],
});
