import { randomUUID } from 'crypto';
import SyncLease from '../models/SyncLease.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const acquireSyncLease = async (name, durationMs) => {
  const now = new Date();
  const owner = randomUUID();
  try {
    await SyncLease.findOneAndUpdate(
      { name, expiresAt: { $lte: now } },
      { $set: { owner, expiresAt: new Date(now.getTime() + durationMs) } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    return owner;
  } catch (error) {
    if (error?.code === 11000) return '';
    throw error;
  }
};

export const releaseSyncLease = async (name, owner) => {
  if (owner) await SyncLease.deleteOne({ name, owner });
};

export const acquireAccountSyncLease = (accountId, durationMs = 15 * 60 * 1000) => (
  acquireSyncLease(`metric-sync:account:${accountId}`, durationMs)
);

export const releaseAccountSyncLease = (accountId, owner) => (
  releaseSyncLease(`metric-sync:account:${accountId}`, owner)
);

export const withProviderSyncSlot = async (platform, task) => {
  const provider = platform === 'youtube' ? 'youtube' : 'meta';
  const slotCount = Math.max(1, Number(
    provider === 'youtube'
      ? process.env.YOUTUBE_SYNC_ACCOUNT_CONCURRENCY
      : process.env.META_SYNC_ACCOUNT_CONCURRENCY
  ) || 2);
  const startedAt = Date.now();
  const waitTimeoutMs = Math.max(5000, Number(process.env.PROVIDER_SYNC_SLOT_TIMEOUT_MS) || 120000);
  let slot = null;

  while (!slot && Date.now() - startedAt < waitTimeoutMs) {
    for (let index = 0; index < slotCount; index += 1) {
      const name = `provider-sync:${provider}:${index}`;
      const owner = await acquireSyncLease(name, 5 * 60 * 1000);
      if (owner) {
        slot = { name, owner };
        break;
      }
    }
    if (!slot) await wait(250);
  }

  if (!slot) {
    const error = new Error(`Timed out waiting for an available ${provider} synchronization slot.`);
    error.code = 'PROVIDER_SYNC_BUSY';
    error.retryable = true;
    throw error;
  }

  try {
    return await task();
  } finally {
    await releaseSyncLease(slot.name, slot.owner);
  }
};
