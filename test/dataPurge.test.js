import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import AutomationEvent from '../src/models/AutomationEvent.js';
import AutomationRule from '../src/models/AutomationRule.js';
import BulkAgentPlan from '../src/models/BulkAgentPlan.js';
import BulkMediaReservation from '../src/models/BulkMediaReservation.js';
import Campaign from '../src/models/Campaign.js';
import CampaignChannel from '../src/models/CampaignChannel.js';
import Conversation from '../src/models/Conversation.js';
import Folder from '../src/models/Folder.js';
import Insight from '../src/models/Insight.js';
import Media from '../src/models/Media.js';
import Message from '../src/models/Message.js';
import MetricSyncStatus from '../src/models/MetricSyncStatus.js';
import OAuthStateNonce from '../src/models/OAuthStateNonce.js';
import PostInsight from '../src/models/PostInsight.js';
import PostMetricDailySnapshot from '../src/models/PostMetricDailySnapshot.js';
import PostMetricSnapshot from '../src/models/PostMetricSnapshot.js';
import PublishedPost from '../src/models/PublishedPost.js';
import SavedCaption from '../src/models/SavedCaption.js';
import ScheduledPost from '../src/models/ScheduledPost.js';
import SocialAccount from '../src/models/SocialAccount.js';
import SocialComment from '../src/models/SocialComment.js';
import User from '../src/models/User.js';
import { purgeSocialAccounts, purgeUserData } from '../src/services/dataPurgeService.js';

const allModels = [
  AutomationEvent, AutomationRule, BulkAgentPlan, BulkMediaReservation, Campaign, CampaignChannel,
  Conversation, Folder, Insight, Media, Message, MetricSyncStatus, OAuthStateNonce, PostInsight,
  PostMetricDailySnapshot, PostMetricSnapshot, PublishedPost, SavedCaption, ScheduledPost,
  SocialAccount, SocialComment, User,
];
const engagementModels = [SocialComment, Conversation, Message, AutomationEvent, AutomationRule];

const chain = (value) => ({
  select: () => chain(value),
  lean: () => Promise.resolve(value),
  distinct: () => Promise.resolve([]),
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

// Replaces model statics with recorders so the purge can run without MongoDB.
const stubModels = ({ user = null, accounts = [] } = {}) => {
  const deletes = new Map();
  const originals = [];
  const stub = (model, name, fn) => {
    originals.push([model, name, Object.getOwnPropertyDescriptor(model, name)]);
    model[name] = fn;
  };
  for (const model of allModels) {
    stub(model, 'deleteMany', async (filter) => {
      deletes.set(model.modelName, [...(deletes.get(model.modelName) || []), filter]);
      return { deletedCount: 0 };
    });
    stub(model, 'deleteOne', async () => ({ deletedCount: 1 }));
    stub(model, 'updateMany', async () => ({ modifiedCount: 0 }));
    stub(model, 'find', () => chain([]));
  }
  stub(SocialAccount, 'find', () => chain(accounts));
  stub(User, 'findById', async () => user);
  const restore = () => originals.reverse().forEach(([model, name, descriptor]) => {
    if (descriptor) Object.defineProperty(model, name, descriptor);
    else delete model[name];
  });
  return { deletes, restore };
};

const ids = (filter) => JSON.stringify(filter);

test('a failed dependent deletion keeps the account reference available for retry', async () => {
  const accountId = new mongoose.Types.ObjectId();
  const { deletes, restore } = stubModels({ accounts: [{ _id: accountId, platform: 'youtube' }] });
  try {
    SocialComment.deleteMany = async () => { throw new Error('Temporary database failure'); };
    await assert.rejects(purgeSocialAccounts([accountId], { revokeProviderAccess: false }), /Temporary database failure/);
    assert.equal(deletes.has('SocialAccount'), false, 'Account reference must survive a partial purge');
  } finally {
    restore();
  }
});

test('disconnecting a social account erases its comments, DMs and automation data', async () => {
  const accountId = new mongoose.Types.ObjectId();
  const { deletes, restore } = stubModels({ accounts: [{ _id: accountId, platform: 'instagram' }] });
  try {
    const result = await purgeSocialAccounts([accountId], { revokeProviderAccess: false });
    assert.equal(result.accountsDeleted, 1);
    for (const model of engagementModels) {
      const filters = deletes.get(model.modelName);
      assert.ok(filters, `${model.modelName} was not purged`);
      assert.match(ids(filters), new RegExp(String(accountId)), `${model.modelName} not scoped to the account`);
    }
  } finally {
    restore();
  }
});

test('deleting a user erases comments, DMs and automation data for their accounts and userId', async () => {
  const userId = new mongoose.Types.ObjectId();
  const accountId = new mongoose.Types.ObjectId();
  const { deletes, restore } = stubModels({
    user: { _id: userId, email: 'creator@example.test' },
    accounts: [{ _id: accountId, platform: 'facebook' }],
  });
  try {
    const result = await purgeUserData(userId, { revokeProviderAccess: false });
    assert.equal(result.userDeleted, true);
    for (const model of engagementModels) {
      const filters = deletes.get(model.modelName);
      assert.ok(filters, `${model.modelName} was not purged`);
      assert.match(ids(filters), new RegExp(String(accountId)), `${model.modelName} not scoped to the account`);
    }
    for (const model of [AutomationEvent, AutomationRule]) {
      assert.match(ids(deletes.get(model.modelName)), new RegExp(String(userId)), `${model.modelName} not scoped to the user`);
    }
  } finally {
    restore();
  }
});

test('deleting a user with no social accounts never issues an unscoped engagement delete', async () => {
  const userId = new mongoose.Types.ObjectId();
  const { deletes, restore } = stubModels({ user: { _id: userId, email: '' } });
  try {
    await purgeUserData(userId, { revokeProviderAccess: false });
    for (const model of engagementModels) {
      for (const filter of deletes.get(model.modelName) || []) {
        assert.notDeepEqual(filter, {}, `${model.modelName} received an empty filter`);
      }
    }
  } finally {
    restore();
  }
});
