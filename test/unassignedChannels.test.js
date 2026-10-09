import test from 'node:test';
import assert from 'node:assert/strict';
import CampaignChannel from '../src/models/CampaignChannel.js';
import SocialAccount from '../src/models/SocialAccount.js';
import { findUnassignedAccounts, assertAccountNotAssignedElsewhere } from '../src/services/unassignedChannelService.js';

test('unassigned pool excludes accounts used by any campaign and disconnected accounts', async (t) => {
  const originalDistinct = CampaignChannel.distinct;
  const originalFind = SocialAccount.find;
  t.after(() => {
    CampaignChannel.distinct = originalDistinct;
    SocialAccount.find = originalFind;
  });
  const accounts = [
    { _id: 'campaign-a-account', isConnected: true, userId: 'owner' },
    { _id: 'campaign-b-account', isConnected: true, userId: 'owner' },
    { _id: 'available-account', isConnected: true, userId: 'owner' },
    { _id: 'expired-account', isConnected: false, userId: 'owner' },
    { _id: 'other-owner-account', isConnected: true, userId: 'other' },
  ];
  CampaignChannel.distinct = async (field, filter) => {
    assert.equal(field, 'socialAccountId');
    assert.deepEqual(filter, { socialAccountId: { $ne: null } });
    return ['campaign-a-account', 'campaign-b-account'];
  };
  SocialAccount.find = (filter) => ({
    populate: function () { return this; },
    sort: () => ({
      lean: async () => accounts.filter((account) => (
        account.isConnected === filter.isConnected
        && !filter._id.$nin.includes(account._id)
        && (!filter.userId || account.userId === filter.userId)
      )),
    }),
  });
  assert.deepEqual(await findUnassignedAccounts({ userId: 'owner' }), [accounts[2]]);
  assert.deepEqual(await findUnassignedAccounts(), [accounts[2], accounts[4]]);
});

test('assignment rejects a channel that another campaign claimed after the list loaded', async (t) => {
  const originalExists = CampaignChannel.exists;
  t.after(() => { CampaignChannel.exists = originalExists; });
  CampaignChannel.exists = async (filter) => {
    assert.deepEqual(filter, { socialAccountId: 'account', campaignId: { $ne: 'target-campaign' } });
    return { _id: 'other-campaign-channel' };
  };
  await assert.rejects(assertAccountNotAssignedElsewhere('account', 'target-campaign'), (error) => (
    error.statusCode === 409 && /already been assigned/.test(error.message)
  ));
});

test('retrying an assignment to the same campaign is allowed', async (t) => {
  const originalExists = CampaignChannel.exists;
  t.after(() => { CampaignChannel.exists = originalExists; });
  CampaignChannel.exists = async (filter) => {
    const existing = { socialAccountId: 'account', campaignId: 'target-campaign' };
    return existing.campaignId !== filter.campaignId.$ne ? existing : null;
  };
  await assert.doesNotReject(assertAccountNotAssignedElsewhere('account', 'target-campaign'));
});
