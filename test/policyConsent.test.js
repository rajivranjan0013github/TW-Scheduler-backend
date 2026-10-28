import test from 'node:test';
import assert from 'node:assert/strict';
import User from '../src/models/User.js';
import SocialAccount from '../src/models/SocialAccount.js';
import SocialComment from '../src/models/SocialComment.js';
import { LEGAL_POLICY_VERSION, hasCurrentPolicyConsent } from '../src/config/legalPolicy.js';
import { requireCurrentPolicyConsent } from '../src/middleware/policyConsent.js';
import { recordPolicyConsent } from '../src/services/policyConsentService.js';
import { findAccountsForEntry, withAccount } from '../src/services/socialProviders/index.js';
import { processStoredComment } from '../src/services/commentAutomationService.js';

const acceptedUser = { policyConsent: { version: LEGAL_POLICY_VERSION, acceptedAt: new Date() } };
const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('old users and stale or incomplete acceptance cannot enter protected features', () => {
  for (const user of [{}, { policyConsent: { version: '2026-10-16', acceptedAt: new Date() } }, { policyConsent: { version: LEGAL_POLICY_VERSION } }]) {
    const res = response();
    requireCurrentPolicyConsent({ user }, res, () => assert.fail('Unaccepted policy must block the request'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'POLICY_CONSENT_REQUIRED');
  }
  let passed = false;
  requireCurrentPolicyConsent({ user: acceptedUser }, response(), () => { passed = true; });
  assert.equal(passed, true);
});

test('an accepted administrator cannot substitute for an unaccepted channel owner in preview', () => {
  const res = response();
  requireCurrentPolicyConsent({ user: {}, authenticatedUser: acceptedUser }, res, () => assert.fail('Preview cannot grant consent'));
  assert.equal(res.statusCode, 403);
});

test('acceptance requires the current version and an explicit affirmative action', async (t) => {
  t.mock.method(User, 'findByIdAndUpdate', () => assert.fail('Invalid acceptance must not write data'));
  for (const body of [{}, { version: LEGAL_POLICY_VERSION }, { version: LEGAL_POLICY_VERSION, accepted: 'true' }, { version: 'old', accepted: true }]) {
    await assert.rejects(recordPolicyConsent('user', body), { statusCode: 400 });
  }
});

test('acceptance records the authenticated user, policy version, and server time', async (t) => {
  const before = Date.now();
  t.mock.method(User, 'findByIdAndUpdate', async (id, update, options) => {
    assert.equal(id, 'authenticated-user');
    assert.equal(update.$set.policyConsent.version, LEGAL_POLICY_VERSION);
    assert.ok(update.$set.policyConsent.acceptedAt.getTime() >= before);
    assert.ok(update.$set.policyConsent.acceptedAt.getTime() <= Date.now());
    assert.equal(options.runValidators, true);
    return { _id: id, ...update.$set };
  });
  const user = await recordPolicyConsent('authenticated-user', { version: LEGAL_POLICY_VERSION, accepted: true, userId: 'someone-else', acceptedAt: '2000-01-01' });
  assert.equal(hasCurrentPolicyConsent(user), true);
});

test('webhook comments and DMs only resolve accounts whose owners accepted', async (t) => {
  const accounts = [{ _id: 'a', userId: 'accepted' }, { _id: 'b', userId: 'unaccepted' }];
  t.mock.method(SocialAccount, 'find', async () => accounts);
  t.mock.method(User, 'exists', async (filter) => {
    assert.equal(filter['policyConsent.version'], LEGAL_POLICY_VERSION);
    return filter._id === 'accepted';
  });
  assert.deepEqual(await findAccountsForEntry('instagram', '123'), [accounts[0]]);
});

test('unaccepted owners cannot make provider calls or process already queued comments', async (t) => {
  const account = { _id: 'a', userId: 'owner', platform: 'youtube' };
  t.mock.method(User, 'exists', async () => null);
  t.mock.method(SocialAccount, 'findOne', async () => account);
  t.mock.method(SocialComment, 'findOne', () => assert.fail('Do not read comment data without acceptance'));
  await assert.rejects(withAccount(account, () => assert.fail('Do not contact the provider')), { code: 'POLICY_CONSENT_REQUIRED' });
  assert.deepEqual(await processStoredComment({ socialAccountId: 'a', socialCommentId: 'comment' }), { handled: 0, reason: 'policy_consent_required' });
});
