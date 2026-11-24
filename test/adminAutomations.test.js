import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Campaign from '../src/models/Campaign.js';
import CampaignChannel from '../src/models/CampaignChannel.js';
import AutomationRule from '../src/models/AutomationRule.js';
import AutomationEvent from '../src/models/AutomationEvent.js';
import User from '../src/models/User.js';
import { authorize } from '../src/middleware/auth.js';
import { requireAdminCampaign, requireAdminPanelUser } from '../src/routes/adminAutomations.js';
import { applyRuleUpdate } from '../src/services/automationRules.js';
import {
  buildCommentFilter,
  buildEventFilter,
  buildRuleFilter,
  cleanAccountIds,
  filterAccounts,
  findAdminCampaign,
  getAccountContext,
  getCampaignAccountQuery,
  prepareRulesForAccounts,
  setRulesEnabled,
  summarizeAutomations,
} from '../src/services/adminAutomationService.js';

const id = () => new mongoose.Types.ObjectId();
const chain = (result) => ({ select: () => ({ lean: async () => result }) });
const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

test('the campaign must be one the admin can access; owners can open any', async (t) => {
  const campaignId = id();
  const findOne = t.mock.method(Campaign, 'findOne', () => ({ select: () => ({ lean: async () => ({ _id: campaignId }) }) }));
  const admin = { _id: id(), role: 'admin', email: 'Admin@Example.com' };

  assert.equal(await findAdminCampaign({ user: admin, query: {} }), null);
  assert.equal(await findAdminCampaign({ user: admin, query: { campaignId: 'nope' } }), null);
  assert.equal(findOne.mock.callCount(), 0);

  assert.deepEqual(await findAdminCampaign({ user: admin, query: { campaignId: String(campaignId) } }), { _id: campaignId });
  assert.deepEqual(findOne.mock.calls[0].arguments[0], {
    _id: String(campaignId),
    $or: [{ mainEmail: 'admin@example.com' }, { createdBy: admin._id }],
  });

  await findAdminCampaign({ user: { _id: id(), role: 'owner' }, query: { campaignId: String(campaignId) } });
  assert.deepEqual(findOne.mock.calls[1].arguments[0], { _id: String(campaignId) });
});

test('only accounts linked to the campaign are in scope', async (t) => {
  const campaignId = id();
  const listed = id();
  const embedded = id();
  const channelAccount = id();
  const distinct = t.mock.method(CampaignChannel, 'distinct', async () => [channelAccount, listed]);

  const query = await getCampaignAccountQuery({
    _id: campaignId,
    accountIds: [listed],
    channels: [{ socialAccountId: embedded }, { socialAccountId: null }],
  });
  assert.deepEqual(distinct.mock.calls[0].arguments, ['socialAccountId', { campaignId, socialAccountId: { $ne: null } }]);
  assert.equal(query.isConnected, true);
  assert.deepEqual(query.$or[0], { campaignId });
  assert.deepEqual(query.$or[1]._id.$in.map(String).sort(), [listed, embedded, channelAccount].map(String).sort());
  assert.equal(query.$or.length, 2, 'accounts the admin owns elsewhere are not included');
});

test('account context lists this campaign\'s handlers, falling back to the owner', async (t) => {
  const ownerId = id();
  const handlerId = id();
  const campaignId = id();
  const assigned = { _id: id(), userId: ownerId };
  const unassigned = { _id: id(), userId: ownerId };
  const channelFind = t.mock.method(CampaignChannel, 'find', () => chain([
    { socialAccountId: assigned._id, assignedHandlerUserId: handlerId },
    { socialAccountId: assigned._id, assignedHandlerUserId: null, assignedHandlerEmail: 'pending@example.com' },
  ]));
  t.mock.method(User, 'find', () => chain([
    { _id: ownerId, name: 'Owner', email: 'owner@example.com' },
    { _id: handlerId, name: 'Handler', email: 'handler@example.com' },
  ]));

  const context = await getAccountContext([assigned, unassigned], campaignId);
  assert.equal(channelFind.mock.calls[0].arguments[0].campaignId, campaignId);
  const info = context[String(assigned._id)];
  assert.deepEqual(info.handlers.map((handler) => handler.email), ['handler@example.com', 'pending@example.com']);
  assert.equal(info.owner.name, 'Owner');
  assert.deepEqual(context[String(unassigned._id)].handlers.map((handler) => handler.name), ['Owner']);
});

test('account filters match handler (or owner), platform and account', () => {
  const handlerId = id();
  const ownerId = id();
  const a = { _id: id(), platform: 'instagram' };
  const b = { _id: id(), platform: 'youtube' };
  const context = {
    [String(a._id)]: { owner: { _id: ownerId }, handlers: [{ _id: handlerId }] },
    [String(b._id)]: { owner: { _id: ownerId }, handlers: [{ _id: ownerId }] },
  };
  const ids = (list) => list.map((account) => String(account._id));
  assert.deepEqual(ids(filterAccounts([a, b], context, { handlerId: String(handlerId) })), [String(a._id)]);
  assert.deepEqual(ids(filterAccounts([a, b], context, { handlerId: String(ownerId) })), [String(a._id), String(b._id)]);
  assert.deepEqual(ids(filterAccounts([a, b], context, { platform: 'youtube' })), [String(b._id)]);
  assert.deepEqual(ids(filterAccounts([a, b], context, { accountId: String(b._id) })), [String(b._id)]);
});

test('rule filter handles status and treats the search as plain text', () => {
  const accountIds = [id()];
  assert.equal(buildRuleFilter(accountIds, { status: 'active' }).enabled, true);
  assert.equal(buildRuleFilter(accountIds, { status: 'paused' }).enabled, false);
  assert.equal(buildRuleFilter(accountIds, {}).enabled, undefined);
  assert.deepEqual(buildRuleFilter(accountIds, { q: ' link (DM) ' }).name, { $regex: 'link \\(DM\\)', $options: 'i' });
});

test('event filter keeps YouTube retention and supports failures and paging', () => {
  const accountIds = [id()];
  const now = new Date('2026-11-01T00:00:00Z');
  const failed = buildEventFilter(accountIds, { status: 'failed', before: '2026-10-30T00:00:00Z' }, now);
  assert.equal(failed.$and.length, 2);
  assert.ok(failed.$and[0].$or.some((clause) => clause.platform));
  assert.deepEqual(failed.$and[1], { $or: [{ replyStatus: 'failed' }, { dmStatus: 'failed' }] });
  assert.deepEqual(failed.createdAt, { $lt: new Date('2026-10-30T00:00:00Z') });

  const loose = buildEventFilter(accountIds, { before: 'not a date', ruleId: 'bad' }, now);
  assert.equal(loose.createdAt, undefined);
  assert.equal(loose.ruleId, undefined);
  assert.equal(loose.$and.length, 1);
});

test('bulk pause and resume only touch valid rules inside the scope', async (t) => {
  const accountIds = [id()];
  const ruleId = id();
  const adminId = id();
  const now = new Date('2026-11-01T00:00:00Z');
  const updates = t.mock.method(AutomationRule, 'updateMany', async () => ({ modifiedCount: 1 }));

  assert.deepEqual(await setRulesEnabled(['nope'], false, accountIds, adminId, now), { error: 'Pick at least one automation.' });
  assert.equal(updates.mock.callCount(), 0);

  assert.deepEqual(await setRulesEnabled([String(ruleId), 'nope', String(ruleId)], false, accountIds, adminId, now), { updated: 1 });
  const [pauseFilter, pauseUpdate] = updates.mock.calls[0].arguments;
  assert.deepEqual(pauseFilter.socialAccountId, { $in: accountIds });
  assert.equal(pauseFilter._id.$in.length, 1);
  assert.equal(pauseFilter.enabled, true);
  assert.deepEqual(pauseUpdate, { $set: { enabled: false, updatedBy: adminId } });

  await setRulesEnabled([String(ruleId)], true, accountIds, adminId, now);
  assert.deepEqual(updates.mock.calls[1].arguments[1], { $set: { enabled: true, updatedBy: adminId, enabledAt: now } });
});

test('summary counts rules, triggers and sent/failed actions', async (t) => {
  t.mock.method(AutomationRule, 'find', () => chain([
    { enabled: true, triggeredCount: 4 },
    { enabled: false, triggeredCount: 2 },
    { enabled: true },
  ]));
  const aggregates = t.mock.method(AutomationEvent, 'aggregate', async () => [{
    events: 5, repliesSent: 3, repliesFailed: 1, dmsSent: 2, dmsFailed: 1,
  }]);
  const summary = await summarizeAutomations([id(), id()], new Date('2026-11-01T00:00:00Z'));
  assert.deepEqual(summary.rules, { total: 3, active: 2, paused: 1 });
  assert.equal(summary.triggers, 6);
  assert.equal(summary.accounts, 2);
  assert.deepEqual(summary.last24h, { events: 5, repliesSent: 3, repliesFailed: 1, dmsSent: 2, dmsFailed: 1 });
  assert.deepEqual(aggregates.mock.calls[0].arguments[0][0].$match.createdAt, { $gte: new Date('2026-10-31T00:00:00Z') });
  assert.deepEqual(aggregates.mock.calls[1].arguments[0][0].$match.createdAt, { $gte: new Date('2026-10-25T00:00:00Z') });
});

test('only owners and admins who are not account handlers reach the admin panel', () => {
  const gate = authorize('owner', 'admin');
  for (const role of ['editor', 'viewer']) {
    const res = fakeRes();
    let passed = false;
    gate({ user: { role } }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
  }

  const handlerRes = fakeRes();
  let handlerPassed = false;
  requireAdminPanelUser({ user: { role: 'admin', userType: 'account_handler' } }, handlerRes, () => { handlerPassed = true; });
  assert.equal(handlerPassed, false);
  assert.equal(handlerRes.statusCode, 403);

  // An admin passes the role checks; with no database in tests the next guard answers 503
  const adminRes = fakeRes();
  requireAdminPanelUser({ user: { role: 'admin', userType: 'campaign_maker' } }, adminRes, () => {});
  assert.equal(adminRes.statusCode, 503);
});

test('rule updates record who made them; bad edits are rejected', () => {
  const adminId = id();
  const rule = new AutomationRule({
    userId: id(), socialAccountId: id(), platform: 'instagram', name: 'Link', triggerType: 'any',
    commentReplies: ['Thanks!'], sendDm: false,
  });
  assert.deepEqual(applyRuleUpdate(rule, { enabled: false }, adminId), {});
  assert.equal(rule.enabled, false);
  assert.equal(String(rule.updatedBy), String(adminId));

  assert.deepEqual(applyRuleUpdate(rule, { name: '   ' }, adminId), { error: 'Give the automation a name.' });
  assert.equal(rule.name, 'Link');
});

test('admin automation requests must name a campaign the admin can open', async (t) => {
  const missing = fakeRes();
  let passed = false;
  await requireAdminCampaign({ user: { _id: id(), role: 'admin' }, query: {} }, missing, () => { passed = true; });
  assert.equal(missing.statusCode, 400);

  t.mock.method(Campaign, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  const foreign = fakeRes();
  await requireAdminCampaign({ user: { _id: id(), role: 'admin', email: 'a@example.com' }, query: { campaignId: String(id()) } }, foreign, () => { passed = true; });
  assert.equal(foreign.statusCode, 404);
  assert.equal(passed, false);

  t.mock.restoreAll();
  const campaign = { _id: id() };
  t.mock.method(Campaign, 'findOne', () => ({ select: () => ({ lean: async () => campaign }) }));
  const req = { user: { _id: id(), role: 'admin', email: 'a@example.com' }, query: { campaignId: String(campaign._id) } };
  await requireAdminCampaign(req, fakeRes(), () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(req.campaign, campaign);
});

test('batch account ids are validated, de-duplicated and capped', () => {
  const a = id();
  assert.deepEqual(cleanAccountIds([String(a), String(a), 'bad', null]).map(String), [String(a)]);
  assert.deepEqual(cleanAccountIds('not a list'), []);
  assert.equal(cleanAccountIds(Array.from({ length: 150 }, () => String(id()))).length, 100);
});

test('one rule per account, each owned by its account owner and credited to the admin', () => {
  const adminId = id();
  const now = new Date('2026-11-01T00:00:00Z');
  const ig = { _id: id(), userId: id(), platform: 'instagram', name: 'Brand IG' };
  const yt = { _id: id(), userId: id(), platform: 'youtube', name: 'Brand YT' };
  const body = { name: 'Link', triggerType: 'any', commentReplies: ['Thanks!'], sendDm: true, dmMessage: 'Here' };

  const { docs, error } = prepareRulesForAccounts([ig, yt], body, adminId, now);
  assert.equal(error, undefined);
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((doc) => String(doc.userId)), [String(ig.userId), String(yt.userId)]);
  assert.ok(docs.every((doc) => doc.createdBy === adminId && doc.enabledAt === now));
  assert.equal(docs[0].sendDm, true);
  assert.equal(docs[1].sendDm, false, 'YouTube has no DMs');
  assert.equal(docs[1].dmMessage, '');
});

test('the whole batch is refused when the form does not work for one account', () => {
  const ig = { _id: id(), userId: id(), platform: 'instagram', name: 'Brand IG' };
  const yt = { _id: id(), userId: id(), platform: 'youtube', name: 'Brand YT' };
  const dmOnly = { name: 'DM only', triggerType: 'any', commentReplies: [], sendDm: true, dmMessage: 'Here' };
  assert.deepEqual(prepareRulesForAccounts([ig, yt], dmOnly, id()), { error: 'Brand YT: Add at least one comment reply.' });

  const paused = prepareRulesForAccounts([ig], { ...dmOnly, enabled: false }, id());
  assert.equal(paused.docs[0].enabledAt, undefined);
});


test('comment feed filter: others\' comments in scope, status, search and paging', () => {
  const accountIds = [id()];
  const now = new Date('2026-01-10T00:00:00Z');
  const base = buildCommentFilter(accountIds, {}, now);
  assert.deepEqual(base.socialAccountId, { $in: accountIds });
  assert.deepEqual(base.isOwn, { $ne: true });
  assert.equal(base.ownerReplied, undefined);
  assert.equal(base.$and.length, 1);

  assert.deepEqual(buildCommentFilter(accountIds, { status: 'unreplied' }, now).ownerReplied, { $ne: true });
  assert.equal(buildCommentFilter(accountIds, { status: 'replied' }, now).ownerReplied, true);

  const searched = buildCommentFilter(accountIds, { q: ' a.b ' }, now);
  assert.deepEqual(searched.$and[1].$or[0], { text: { $regex: 'a\\.b', $options: 'i' } });

  const paged = buildCommentFilter(accountIds, { before: '2026-01-05T00:00:00Z' }, now);
  assert.deepEqual(paged.commentedAt, { $lt: new Date('2026-01-05T00:00:00Z') });
  assert.equal(buildCommentFilter(accountIds, { before: 'nope' }, now).commentedAt, undefined);
});
