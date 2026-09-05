import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Media from '../src/models/Media.js';
import SocialAccount from '../src/models/SocialAccount.js';
import Campaign from '../src/models/Campaign.js';
import CampaignChannel from '../src/models/CampaignChannel.js';
import PublishedPost from '../src/models/PublishedPost.js';
import MetricSyncStatus from '../src/models/MetricSyncStatus.js';
import { validatePersonalSchedulingAccess } from '../src/routes/scheduler.js';
import { getCreatorAnalytics } from '../src/services/creatorAnalyticsService.js';

const selectedResult = (items) => ({
  select: async () => items,
});

test('personal media is a supported creator-owned scope', () => {
  assert.ok(Media.schema.path('scope').enumValues.includes('personal'));
});

test('personal scheduling accepts only the creator owned account and media', async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const accountId = new mongoose.Types.ObjectId();
  const mediaId = new mongoose.Types.ObjectId();
  const originalAccountFind = SocialAccount.find;
  const originalMediaFind = Media.find;

  t.after(() => {
    SocialAccount.find = originalAccountFind;
    Media.find = originalMediaFind;
  });

  SocialAccount.find = (query) => {
    assert.equal(String(query.userId), String(userId));
    assert.equal(query.isConnected, true);
    return selectedResult([{ _id: accountId }]);
  };
  Media.find = (query) => {
    assert.equal(String(query.userId), String(userId));
    assert.equal(query.scope, 'personal');
    assert.equal(query.campaignId, null);
    return selectedResult([{ _id: mediaId }]);
  };

  const result = await validatePersonalSchedulingAccess({
    userId,
    socialAccountIds: [accountId],
    campaignChannelIds: [],
    channelTargets: [{ socialAccountId: accountId, campaignChannelId: null }],
    mediaIds: [mediaId],
  });

  assert.deepEqual(result, { ok: true });
});

test('personal scheduling rejects campaign channel targets before database access', async () => {
  const result = await validatePersonalSchedulingAccess({
    userId: new mongoose.Types.ObjectId(),
    socialAccountIds: [new mongoose.Types.ObjectId()],
    campaignChannelIds: [new mongoose.Types.ObjectId()],
    channelTargets: [{
      socialAccountId: new mongoose.Types.ObjectId(),
      campaignChannelId: new mongoose.Types.ObjectId(),
    }],
    mediaIds: [new mongoose.Types.ObjectId()],
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /Campaign channels cannot be used/);
});

test('creator analytics includes directly owned accounts without campaign membership', async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const accountId = new mongoose.Types.ObjectId();
  const originals = {
    socialAccountFind: SocialAccount.find,
    campaignChannelFind: CampaignChannel.find,
    campaignFind: Campaign.find,
    publishedPostFind: PublishedPost.find,
    metricSyncStatusFind: MetricSyncStatus.find,
  };
  let publishedPostQuery;

  t.after(() => {
    SocialAccount.find = originals.socialAccountFind;
    CampaignChannel.find = originals.campaignChannelFind;
    Campaign.find = originals.campaignFind;
    PublishedPost.find = originals.publishedPostFind;
    MetricSyncStatus.find = originals.metricSyncStatusFind;
  });

  SocialAccount.find = () => ({
    lean: async () => [{
      _id: accountId,
      userId,
      name: 'Independent Creator',
      username: 'independent_creator',
      platform: 'instagram',
      isConnected: true,
    }],
  });
  CampaignChannel.find = () => ({ lean: async () => [] });
  Campaign.find = () => ({ select: () => ({ lean: async () => [] }) });
  PublishedPost.find = (query) => {
    publishedPostQuery = query;
    return {
      select: () => ({
        lean: async () => [{
          _id: new mongoose.Types.ObjectId(),
          accountId,
          platform: 'instagram',
          publishedAt: new Date(),
          latestViews: 120,
          latestLikes: 15,
          latestComments: 3,
        }],
      }),
    };
  };
  MetricSyncStatus.find = () => ({
    select: () => ({
      lean: async () => [{
        lastSuccessAt: new Date('2026-09-05T10:30:00.000Z'),
      }],
    }),
  });

  const result = await getCreatorAnalytics({
    user: { _id: userId, email: 'creator@example.com' },
    timeZone: 'UTC',
  });

  assert.equal(publishedPostQuery.campaignId, undefined);
  assert.equal(result.metrics.accounts, 1);
  assert.equal(result.metrics.posts, 1);
  assert.equal(result.metrics.lifetimeViews, 120);
  assert.equal(result.metrics.lastSyncedAt.toISOString(), '2026-09-05T10:30:00.000Z');
});
