import SocialComment from '../models/SocialComment.js';

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
      $setOnInsert: {
        platform: account.platform,
        mediaId,
        parentId: String(parentId),
        text: String(text || '').slice(0, 2200),
        username: account.username || '',
        name: account.name || '',
        commentedAt,
        isOwn: true,
        unseen: false,
      },
    },
    { upsert: true }
  );
};
