import SocialAccount from '../models/SocialAccount.js';
import AutomationRule from '../models/AutomationRule.js';
import SocialComment from '../models/SocialComment.js';
import { withAccount } from './socialProviders/index.js';
import { COMMENT_SCOPE } from './socialProviders/youtube.js';

// Comments can show up in the API a little after their publish time; re-check this window each poll
const POLL_OVERLAP_MS = 10 * 60 * 1000;

/**
 * Stores a channel's newest comments and returns the ones that should run through automations.
 * The first poll for a channel only backfills, so old comments never get automated replies.
 */
export const collectNewYoutubeComments = async (account, threads, { lastPolledAt }) => {
  const channelId = String(account.accountId);
  const isFirstPoll = !lastPolledAt;
  const since = lastPolledAt ? new Date(lastPolledAt).getTime() - POLL_OVERLAP_MS : 0;
  const toAutomate = [];

  for (const thread of threads) {
    const items = [thread, ...thread.replies.map((reply) => ({ ...reply, parentId: thread.id, mediaId: thread.mediaId }))];
    for (const item of items) {
      if (item.fromId === channelId) {
        if (item.parentId) {
          await SocialComment.updateOne({ socialAccountId: account._id, commentId: item.parentId }, { $set: { ownerReplied: true } });
        }
        continue;
      }
      const commentedAt = item.timestamp ? new Date(item.timestamp) : new Date();
      const isNew = !isFirstPoll && commentedAt.getTime() >= since;
      await SocialComment.updateOne(
        { socialAccountId: account._id, commentId: item.id },
        {
          $setOnInsert: {
            platform: 'youtube',
            mediaId: item.mediaId || thread.mediaId,
            parentId: item.parentId || '',
            text: item.text.slice(0, 2200),
            username: item.username,
            name: '',
            commentedAt,
            unseen: isNew,
          },
        },
        { upsert: true }
      );
      if (isNew && !item.parentId) {
        toAutomate.push({
          platform: 'youtube',
          entryId: channelId,
          commentId: item.id,
          parentId: '',
          mediaId: thread.mediaId,
          text: item.text,
          fromId: item.fromId,
          fromUsername: item.username,
          fromName: '',
        });
      }
    }
  }
  return toAutomate;
};

export const pollYoutubeAccount = async (account, enqueueComment) => {
  const pollStartedAt = new Date();
  return withAccount(account, async (provider, freshAccount) => {
    const threads = await provider.fetchChannelComments(freshAccount, 50);
    const toAutomate = await collectNewYoutubeComments(freshAccount, threads, {
      lastPolledAt: freshAccount.metadata?.youtubeCommentsPolledAt,
    });
    for (const comment of toAutomate) await enqueueComment(comment);

    freshAccount.metadata = { ...(freshAccount.metadata || {}), youtubeCommentsPolledAt: pollStartedAt.toISOString() };
    freshAccount.markModified('metadata');
    await freshAccount.save();
    return { comments: threads.length, automated: toAutomate.length };
  });
};

/**
 * YouTube's quota is shared by every channel on the Google project, so only channels
 * with an enabled automation are polled. The Comments feed refreshes the rest when opened.
 */
export const pollYoutubeComments = async (enqueueComment) => {
  const accountIds = await AutomationRule.distinct('socialAccountId', { platform: 'youtube', enabled: true });
  if (accountIds.length === 0) return { polled: 0 };

  const accounts = await SocialAccount.find({
    _id: { $in: accountIds },
    platform: 'youtube',
    isConnected: true,
    scopes: COMMENT_SCOPE,
  });
  let polled = 0;
  for (const account of accounts) {
    try {
      await pollYoutubeAccount(account, enqueueComment);
      polled += 1;
    } catch (error) {
      console.error(`[YouTube comments] Poll failed for ${account.name}:`, error.message);
    }
  }
  return { polled };
};
