import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import SocialAccount, { sanitizeSocialAccount } from '../src/models/SocialAccount.js';
import User from '../src/models/User.js';
import { parseMetaSignedRequest } from '../src/routes/auth.js';

test('User schema never serializes password hashes', () => {
  const user = new User({
    email: 'reviewer@example.com',
    name: 'Reviewer',
    password: '$2b$12$exampleHashThatMustNeverReachTheClient',
  });

  const jsonResult = JSON.parse(JSON.stringify(user));
  assert.equal(jsonResult.email, 'reviewer@example.com');
  assert.equal(jsonResult.password, undefined);
  assert.equal(User.schema.path('password').options.select, false);
});

test('SocialAccount schema strips accessToken and refreshToken on toJSON', () => {
  const accountDoc = new SocialAccount({
    userId: new mongoose.Types.ObjectId(),
    platform: 'facebook',
    accountId: '123456789',
    name: 'Test Page',
    username: 'testpage',
    accessToken: 'EAAB_SECRET_ACCESS_TOKEN_DO_NOT_EXPOSE',
    refreshToken: 'REFRESH_SECRET_DO_NOT_EXPOSE',
    authProvider: 'facebook',
  });

  const jsonResult = JSON.parse(JSON.stringify(accountDoc));

  assert.equal(jsonResult.name, 'Test Page');
  assert.equal(jsonResult.accountId, '123456789');
  assert.equal(jsonResult.accessToken, undefined, 'accessToken must be stripped on toJSON');
  assert.equal(jsonResult.refreshToken, undefined, 'refreshToken must be stripped on toJSON');
});

test('sanitizeSocialAccount strips tokens from plain objects and arrays', () => {
  const mockAccount = {
    _id: 'acc_123',
    name: 'Sample Channel',
    platform: 'instagram',
    accessToken: 'EAAC_SUPER_SENSITIVE_TOKEN',
    refreshToken: 'SUPER_SECRET_REFRESH',
    metadata: { facebookUserId: 'fb_user_456' },
  };

  const sanitized = sanitizeSocialAccount(mockAccount);
  assert.equal(sanitized.name, 'Sample Channel');
  assert.equal(sanitized.metadata.facebookUserId, 'fb_user_456');
  assert.equal(sanitized.accessToken, undefined, 'accessToken must not exist in sanitized object');
  assert.equal(sanitized.refreshToken, undefined, 'refreshToken must not exist in sanitized object');

  const sanitizedArray = sanitizeSocialAccount([mockAccount, { ...mockAccount, _id: 'acc_456' }]);
  assert.equal(sanitizedArray.length, 2);
  assert.equal(sanitizedArray[0].accessToken, undefined);
  assert.equal(sanitizedArray[1].accessToken, undefined);
});

test('parseMetaSignedRequest verifies valid signatures and rejects invalid ones', () => {
  const appSecret = 'meta_test_secret_xyz123';
  const validPayload = {
    algorithm: 'HMAC-SHA256',
    user_id: 'fb_user_99999',
    issued_at: Math.floor(Date.now() / 1000),
  };

  const encodedPayload = Buffer.from(JSON.stringify(validPayload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest();
  const encodedSig = Buffer.from(hmac).toString('base64url');
  const validSignedRequest = `${encodedSig}.${encodedPayload}`;

  // 1. Valid request parses successfully
  const parsed = parseMetaSignedRequest(validSignedRequest, appSecret);
  assert.ok(parsed, 'Should parse valid signed request');
  assert.equal(parsed.user_id, 'fb_user_99999');

  // 2. Tampered payload fails verification
  const tamperedPayload = Buffer.from(JSON.stringify({ ...validPayload, user_id: 'hacker_user' })).toString('base64url');
  const tamperedSignedRequest = `${encodedSig}.${tamperedPayload}`;
  assert.equal(parseMetaSignedRequest(tamperedSignedRequest, appSecret), null, 'Tampered payload should be rejected');

  // 3. Wrong secret fails verification
  assert.equal(parseMetaSignedRequest(validSignedRequest, 'wrong_secret'), null, 'Wrong appSecret should be rejected');

  // 4. Malformed string fails safely
  assert.equal(parseMetaSignedRequest('invalid.string.format', appSecret), null, 'Malformed string should be rejected');
  assert.equal(parseMetaSignedRequest(null, appSecret), null, 'Null signed_request should be rejected');
});

test('signOAuthState and verifyOAuthState protect against OAuth CSRF', async () => {
  const { signOAuthState, verifyOAuthState } = await import('../src/routes/accounts.js');
  const userId = 'user_abc123';
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-only-oauth-state-secret-with-sufficient-entropy';

  try {

  // 1. Valid signed state verifies correctly
  const state = signOAuthState({ userId, campaignId: 'camp_456', provider: 'facebook' });
  assert.ok(typeof state === 'string' && state.includes('.'), 'State must be signed with HMAC delimiter');

  const verified = verifyOAuthState(state, userId, 'facebook');
  assert.ok(verified, 'Valid state must verify');
  assert.equal(verified.userId, userId);
  assert.equal(verified.campaignId, 'camp_456');
  assert.ok(verified.nonce, 'Signed state must contain an unpredictable nonce');

  // 2. State for a different user fails verification
  const wrongUserVerified = verifyOAuthState(state, 'user_attacker999');
  assert.equal(wrongUserVerified, null, 'State from different user must be rejected');

  // 3. Tampered state fails verification
  const [encoded, sig] = state.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ userId: 'user_attacker999', ts: Date.now() })).toString('base64url');
  assert.equal(verifyOAuthState(`${tamperedPayload}.${sig}`, userId), null, 'Tampered state must be rejected');

  // 4. Expired state fails verification
  const expiredState = signOAuthState({ userId, ts: Date.now() - (20 * 60 * 1000) });
  assert.equal(verifyOAuthState(expiredState, userId), null, 'Expired state must be rejected');

  // 5. Legacy unsigned JSON and provider confusion are rejected
  assert.equal(verifyOAuthState(JSON.stringify({ userId, provider: 'facebook' }), userId, 'facebook'), null);
  assert.equal(verifyOAuthState(state, userId, 'instagram'), null);
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});

test('revokeMetaPermissions safely handles missing tokens', async () => {
  const { revokeMetaPermissions } = await import('../src/services/metaService.js');
  const result = await revokeMetaPermissions(null);
  assert.equal(result, undefined);
  const resultEmpty = await revokeMetaPermissions('');
  assert.equal(resultEmpty, undefined);
});

test('SocialAccount credentials are encrypted at rest while document access remains transparent', () => {
  const originalKey = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  try {
    const account = new SocialAccount({
      userId: new mongoose.Types.ObjectId(),
      platform: 'youtube',
      accountId: 'channel_secure',
      name: 'Secure Channel',
      accessToken: 'access-token-plaintext',
      refreshToken: 'refresh-token-plaintext',
    });
    assert.match(account.get('accessToken', null, { getters: false }), /^enc:/);
    assert.match(account.get('refreshToken', null, { getters: false }), /^enc:/);
    assert.equal(account.accessToken, 'access-token-plaintext');
    assert.equal(account.refreshToken, 'refresh-token-plaintext');

    const updateQuery = SocialAccount.findOneAndUpdate(
      { accountId: 'channel_secure' },
      { $set: { accessToken: 'updated-access-token' } },
    );
    const castedUpdate = updateQuery._castUpdate(updateQuery.getUpdate());
    assert.match(castedUpdate.$set.accessToken, /^enc:/, 'query updates must also encrypt credentials');
  } finally {
    if (originalKey === undefined) delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    else process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = originalKey;
  }
});
