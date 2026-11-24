import SocialComment from '../models/SocialComment.js';
import { youtubeEngagementExpiry } from '../utils/engagementRetention.js';

export const markParentReplied = (account, parentId) => SocialComment.updateOne(
  { socialAccountId: account._id, commentId: parentId },
  { $set: { ownerReplied: true } }
);

/**
 * Stores one of the account's own replies so it shows under the comment it answers,
 * and marks that comment as replied.
 */
export const recordOwnReply = async (account, { commentId, parentId, mediaId = '', text, commentedAt = new Date() }) => {
  if (!commentId || !parentId) return;
  await markParentReplied(account, parentId);
  await SocialComment.updateOne(
    { socialAccountId: account._id, commentId: String(commentId) },
    {
      // $set also repairs a reply stored earlier as someone else's comment (its author was missing then)
      $set: {
        username: account.username || '',
        name: account.name || '',
        isOwn: true,
        unseen: false,
      },
      $setOnInsert: {
        platform: account.platform,
        mediaId,
        parentId: String(parentId),
        text: String(text || '').slice(0, 2200),
        commentedAt,
        ...youtubeEngagementExpiry(account.platform),
      },
    },
    { upsert: true }
  );
};
