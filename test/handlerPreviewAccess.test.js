import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Campaign from '../src/models/Campaign.js';
import CampaignChannel from '../src/models/CampaignChannel.js';
import SocialAccount from '../src/models/SocialAccount.js';
import ScheduledPost from '../src/models/ScheduledPost.js';
import PublishedPost from '../src/models/PublishedPost.js';
import Media from '../src/models/Media.js';
import { canPreviewHandler, clearPreviewAccessCache } from '../src/services/handlerPreviewAccess.js';

const id = () => new mongoose.Types.ObjectId();
const chain = (result) => ({ select: () => ({ lean: async () => result }) });
const admin = () => ({ _id: id(), role: 'admin', email: 'admin@example.com' });
const handler = () => ({ _id: id(), userType: 'account_handler', email: 'Handler@Example.com' });

// Every lookup answers "no" unless a test overrides it
const mockNothing = (t, campaigns) => {
  const calls = {};
  const track = (name, result) => async (...args) => { (calls[name] ||= []).push(args); return result; };
  t.mock.method(Campaign, 'find', (...args) => { (calls.campaigns ||= []).push(args); return chain(campaigns); });
  t.mock.method(CampaignChannel, 'exists', track('channelExists', null));
  t.mock.method(CampaignChannel, 'distinct', track('channelDistinct', []));
  t.mock.method(SocialAccount, 'exists', track('accountExists', null));
  t.mock.method(ScheduledPost, 'exists', track('scheduledExists', null));
  t.mock.method(PublishedPost, 'exists', track('publishedExists', null));
  t.mock.method(Media, 'exists', track('mediaExists', null));
  return calls;
};

test.beforeEach(() => clearPreviewAccessCache());

test('owners may preview any handler without lookups', async (t) => {
  const calls = mockNothing(t, []);
  assert.equal(await canPreviewHandler({ _id: id(), role: 'owner' }, handler()), true);
  assert.equal(calls.campaigns, undefined);
});

test('an admin without campaigns cannot preview anyone', async (t) => {
  const user = admin();
  const calls = mockNothing(t, []);
  assert.equal(await canPreviewHandler(user, handler()), false);
  assert.deepEqual(calls.campaigns[0][0], { $or: [{ mainEmail: 'admin@example.com' }, { createdBy: user._id }] });
  assert.equal(calls.channelExists, undefined);
});

test('a channel assignment in the campaign (by user or by email) allows the preview', async (t) => {
  const byEmail = handler();
  const calls = mockNothing(t, [{ _id: id(), channels: [{ assignedHandlerEmail: 'handler@example.com' }] }]);
  assert.equal(await canPreviewHandler(admin(), byEmail), true);
  assert.equal(calls.channelExists, undefined);

  clearPreviewAccessCache();
  const byId = handler();
  t.mock.restoreAll();
  mockNothing(t, [{ _id: id(), channels: [{ assignedHandlerUserId: byId._id }] }]);
  assert.equal(await canPreviewHandler(admin(), byId), true);
});

test('a campaign-channel record assigning the handler allows the preview', async (t) => {
  const user = handler();
  const campaignId = id();
  const calls = mockNothing(t, [{ _id: campaignId, channels: [] }]);
  t.mock.method(CampaignChannel, 'exists', async (filter) => { (calls.channelExists ||= []).push([filter]); return { _id: id() }; });
  assert.equal(await canPreviewHandler(admin(), user), true);
  assert.deepEqual(calls.channelExists[0][0], {
    campaignId: { $in: [campaignId] },
    $or: [{ assignedHandlerUserId: user._id }, { assignedHandlerEmail: 'handler@example.com' }],
  });
});

test('owning an account linked to the campaign allows the preview', async (t) => {
  const user = handler();
  const campaignId = id();
  const listed = id();
  const channelAccount = id();
  const calls = mockNothing(t, [{ _id: campaignId, accountIds: [listed], channels: [] }]);
  t.mock.method(CampaignChannel, 'distinct', async () => [channelAccount]);
  t.mock.method(SocialAccount, 'exists', async (filter) => { (calls.accountExists ||= []).push([filter]); return { _id: id() }; });
  assert.equal(await canPreviewHandler(admin(), user), true);
  const [filter] = calls.accountExists[0];
  assert.equal(filter.userId, user._id);
  assert.deepEqual(filter.$or[0], { campaignId: { $in: [campaignId] } });
  assert.deepEqual(filter.$or[1]._id.$in.map(String), [listed, channelAccount].map(String));
});

test('posts or media in the campaign allow the preview', async (t) => {
  mockNothing(t, [{ _id: id(), channels: [] }]);
  t.mock.method(Media, 'exists', async () => ({ _id: id() }));
  assert.equal(await canPreviewHandler(admin(), handler()), true);
});

test('a handler with no tie to the admin\'s campaigns is refused after every check', async (t) => {
  const calls = mockNothing(t, [{ _id: id(), channels: [{ assignedHandlerEmail: 'someone@example.com' }] }]);
  assert.equal(await canPreviewHandler(admin(), handler()), false);
  for (const name of ['channelExists', 'accountExists', 'scheduledExists', 'publishedExists', 'mediaExists']) {
    assert.equal(calls[name].length, 1, name);
  }
});

test('answers are cached per admin and handler for a minute', async (t) => {
  const user = admin();
  const target = handler();
  const calls = mockNothing(t, []);
  const now = Date.now();
  assert.equal(await canPreviewHandler(user, target, now), false);
  assert.equal(await canPreviewHandler(user, target, now + 30 * 1000), false);
  assert.equal(calls.campaigns.length, 1);

  await canPreviewHandler(admin(), target, now);
  assert.equal(calls.campaigns.length, 2, 'another admin is checked separately');

  await canPreviewHandler(user, target, now + 61 * 1000);
  assert.equal(calls.campaigns.length, 3, 'expired entries are checked again');
});
