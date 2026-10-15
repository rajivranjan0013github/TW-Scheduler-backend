import SocialComment from '../models/SocialComment.js';
import { fetchMediaComments, fetchRecentMedia, findAccountsForEntry, getOwnIds, withAccount } from './socialProviders/index.js';
import { collectNewYoutubeComments } from './youtubeCommentPoller.js';
import { recordOwnReply } from './ownReplyStore.js';

export { recordOwnReply };

const SYNC_MIN_INTERVAL_MS = 2 * 60 * 1000;
const SYNC_MEDIA_LIMIT = 10;

const isOwnComment = (account, { fromId, username }) => (
  (fromId && getOwnIds(account).includes(String(fromId)))
  || (Boolean(username) && String(username).toLowerCase() === String(account.username || '').toLowerCase())
);

/**
 * Saves a comment from the webhook. The account's own replies are stored as replies
 * of the comment they answer (own top-level comments are ignored).
 */
export const recordWebhookComment = async (comment) => {
  const accounts = await findAccountsForEntry(comment.platform || 'instagram', comment.entryId);
  for (const account of accounts) {
    if (comment.fromId === comment.entryId || isOwnComment(account, { fromId: comment.fromId, username: comment.fromUsername })) {
      if (comment.parentId) {
        await recordOwnReply(account, {
          commentId: comment.commentId,
          parentId: comment.parentId,
          mediaId: comment.mediaId,
          text: comment.text,
        });
      }
      continue;
    }
    await SocialComment.updateOne(
      { socialAccountId: account._id, commentId: comment.commentId },
      {
        $setOnInsert: {
          platform: account.platform,
          mediaId: comment.mediaId,
          parentId: comment.parentId,
          text: comment.text.slice(0, 2200),
          username: comment.fromUsername || '',
          name: comment.fromName || '',
          commentedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }
};

/**
 * Backfills comments on the latest posts so the feed has history and catches up
 * on anything the webhook missed. Synced comments are not flagged as new.
 */
export const syncRecentComments = async (account, { force = false } = {}) => {
  const lastSync = account.metadata?.commentsSyncedAt ? new Date(account.metadata.commentsSyncedAt).getTime() : 0;
  if (!force && Date.now() - lastSync < SYNC_MIN_INTERVAL_MS) return { skipped: true };

  if (account.platform === 'youtube') {
    // One call covers every video on the channel; stored as already seen, and never automated from here
    await withAccount(account, async (provider, freshAccount) => {
      const threads = await provider.fetchChannelComments(freshAccount, 100);
      await collectNewYoutubeComments(freshAccount, threads, { lastPolledAt: null });
    });
    account.metadata = { ...(account.metadata || {}), commentsSyncedAt: new Date().toISOString() };
    account.markModified('metadata');
    await account.save();
    return { skipped: false };
  }

  const media = await fetchRecentMedia(account, SYNC_MEDIA_LIMIT);
  let stored = 0;

  for (const post of media) {
    const comments = await fetchMediaComments(account, post.id);
    for (const comment of comments) {
      const thread = [comment, ...comment.replies.map((reply) => ({ ...reply, parentId: comment.id }))];
      const ownerReplied = comment.replies.some((reply) => isOwnComment(account, reply));
      for (const item of thread) {
        if (isOwnComment(account, item)) {
          if (item.parentId) {
            await recordOwnReply(account, {
              commentId: item.id,
              parentId: item.parentId,
              mediaId: String(post.id),
              text: item.text,
              commentedAt: item.timestamp ? new Date(item.timestamp) : new Date(),
            });
          }
          continue;
        }
        const result = await SocialComment.updateOne(
          { socialAccountId: account._id, commentId: String(item.id) },
          {
            $setOnInsert: {
              platform: account.platform,
              mediaId: String(post.id),
              parentId: item.parentId ? String(item.parentId) : '',
              text: String(item.text || '').slice(0, 2200),
              username: item.username || '',
              name: item.name || '',
              commentedAt: item.timestamp ? new Date(item.timestamp) : new Date(),
              unseen: false,
            },
            ...(item === comment && ownerReplied ? { $set: { ownerReplied: true } } : {}),
          },
          { upsert: true }
        );
        if (result.upsertedCount) stored += 1;
      }
    }
  }

  account.metadata = { ...(account.metadata || {}), commentsSyncedAt: new Date().toISOString() };
  account.markModified('metadata');
  await account.save();
  return { skipped: false, stored };
};

