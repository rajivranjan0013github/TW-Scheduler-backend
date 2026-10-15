import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { ensureFreshAccountToken } from './tokenHealthService.js';
import { findAccountsForEntry, getOwnIds, getProvider, withAccount } from './socialProviders/index.js';

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROFILE_REFRESH_MS = 24 * 60 * 60 * 1000;
const SYNC_MIN_INTERVAL_MS = 2 * 60 * 1000;

export const isReplyWindowOpen = (conversation, now = Date.now()) => (
  Boolean(conversation?.lastInboundAt) && now - new Date(conversation.lastInboundAt).getTime() < REPLY_WINDOW_MS
);

export const getReplyWindowClosesAt = (conversation) => (
  conversation?.lastInboundAt ? new Date(new Date(conversation.lastInboundAt).getTime() + REPLY_WINDOW_MS) : null
);

const summarizeMessage = ({ text, attachments }) => {
  if (text) return text.slice(0, 200);
  if (attachments?.length) return attachments[0].type === 'image' ? '📷 Photo' : '📎 Attachment';
  return '';
};

/**
 * Normalizes one item of `entry.messaging` from an Instagram or Facebook Page webhook (same format).
 * Echoes are messages the account itself sent (from ThousandPost or the Instagram / Messenger apps).
 */
export const parseMessagingEvent = (entryId, item, platform = 'instagram') => {
  const message = item?.message;
  if (!message?.mid || message.is_deleted || message.is_unsupported) return null;
  const isEcho = Boolean(message.is_echo);
  const participantId = String(isEcho ? item.recipient?.id || '' : item.sender?.id || '');
  if (!participantId) return null;
  return {
    platform,
    entryId: String(entryId),
    mid: String(message.mid),
    direction: isEcho ? 'out' : 'in',
    participantId,
    text: String(message.text || ''),
    attachments: (message.attachments || [])
      .map((attachment) => ({ type: String(attachment.type || 'file'), url: String(attachment.payload?.url || '') }))
      .slice(0, 10),
    sentAt: new Date(Number(item.timestamp) || Date.now()),
  };
};

const refreshProfileIfStale = async (account, conversation) => {
  const fetchedAt = conversation.profileFetchedAt ? new Date(conversation.profileFetchedAt).getTime() : 0;
  if (Date.now() - fetchedAt < PROFILE_REFRESH_MS) return;
  try {
    const profile = await getProvider(account.platform).fetchProfile(account, conversation.participantId);
    await Conversation.updateOne({ _id: conversation._id }, { $set: { ...profile, profileFetchedAt: new Date() } });
  } catch (error) {
    // Profile access can be refused (e.g. user blocked the account); the thread still works without it
    await Conversation.updateOne({ _id: conversation._id }, { $set: { profileFetchedAt: new Date() } });
  }
};

/**
 * Stores one message and moves the conversation preview forward if it is the newest.
 * Returns false when the message was already stored (webhook retry or echo of our own send).
 */
const recordMessage = async (account, conversation, message, { countUnread = true } = {}) => {
  try {
    await Message.create({
      conversationId: conversation._id,
      socialAccountId: account._id,
      mid: message.mid,
      direction: message.direction,
      text: message.text,
      attachments: message.attachments || [],
      sentAt: message.sentAt,
      sentByUserId: message.sentByUserId,
    });
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }

  const isNewest = !conversation.lastMessageAt || message.sentAt >= new Date(conversation.lastMessageAt);
  const update = { $set: {} };
  if (isNewest) {
    update.$set.lastMessageText = summarizeMessage(message);
    update.$set.lastMessageDirection = message.direction;
    update.$set.lastMessageAt = message.sentAt;
  }
  if (message.direction === 'in') {
    if (!conversation.lastInboundAt || message.sentAt > new Date(conversation.lastInboundAt)) {
      update.$set.lastInboundAt = message.sentAt;
    }
    if (countUnread) update.$inc = { unreadCount: 1 };
  }
  if (Object.keys(update.$set).length || update.$inc) {
    await Conversation.updateOne({ _id: conversation._id }, update);
  }
  return true;
};

const findOrCreateConversation = (account, participantId, profile = {}) => Conversation.findOneAndUpdate(
  { socialAccountId: account._id, participantId },
  { $setOnInsert: { socialAccountId: account._id, participantId, platform: account.platform, ...profile } },
  { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
);

export const handleIncomingMessage = async (event) => {
  const accounts = await findAccountsForEntry(event.platform || 'instagram', event.entryId);
  for (const account of accounts) {
    if ([...getOwnIds(account), event.entryId].includes(event.participantId)) continue;

    const conversation = await findOrCreateConversation(account, event.participantId);
    await recordMessage(account, conversation, event);
    try {
      await refreshProfileIfStale(await ensureFreshAccountToken(account), conversation);
    } catch (error) {
      console.warn(`[Inbox] Profile refresh skipped for ${account.name}:`, error.message);
    }
  }
};

/**
 * Pulls recent threads from Instagram / Messenger so conversations from before the webhook was set up
 * (or ones missed while the server was down) still appear in the inbox.
 */
export const syncConversations = async (account, { force = false } = {}) => {
  const lastSync = account.metadata?.inboxSyncedAt ? new Date(account.metadata.inboxSyncedAt).getTime() : 0;
  if (!force && Date.now() - lastSync < SYNC_MIN_INTERVAL_MS) return { skipped: true };

  return withAccount(account, async (provider, freshAccount) => {
    const threads = await provider.fetchConversations(freshAccount);
    let stored = 0;
    for (const thread of threads) {
      const conversation = await findOrCreateConversation(freshAccount, thread.participant.id, {
        participantUsername: thread.participant.username,
        participantName: thread.participant.name,
      });
      // Oldest first so the conversation preview ends on the newest message
      for (const message of [...thread.messages].reverse()) {
        const saved = await recordMessage(freshAccount, await Conversation.findById(conversation._id), {
          mid: message.id,
          direction: message.fromId === thread.participant.id ? 'in' : 'out',
          text: message.text,
          attachments: [],
          sentAt: new Date(message.createdAt),
        }, { countUnread: false });
        if (saved) stored += 1;
      }
      await refreshProfileIfStale(freshAccount, conversation);
    }

    freshAccount.metadata = { ...(freshAccount.metadata || {}), inboxSyncedAt: new Date().toISOString() };
    freshAccount.markModified('metadata');
    await freshAccount.save();
    return { skipped: false, stored };
  });
};

export const sendConversationMessage = async (account, conversation, text, userId) => {
  if (!isReplyWindowOpen(conversation)) {
    const error = new Error('You can only reply within 24 hours of their last message. Wait for them to message again.');
    error.statusCode = 409;
    throw error;
  }

  let data;
  let freshAccount;
  try {
    data = await withAccount(account, (provider, current) => {
      freshAccount = current;
      return provider.sendMessage(current, conversation.participantId, text);
    });
  } catch (error) {
    error.statusCode = 502;
    throw error;
  }

  const message = {
    mid: String(data.message_id || `local-${Date.now()}`),
    direction: 'out',
    text,
    attachments: [],
    sentAt: new Date(),
    sentByUserId: userId,
  };
  await recordMessage(freshAccount, conversation, message);
  return message;
};
