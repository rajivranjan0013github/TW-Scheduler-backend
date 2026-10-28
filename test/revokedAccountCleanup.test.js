import test from 'node:test';
import assert from 'node:assert/strict';
import SocialAccount from '../src/models/SocialAccount.js';
import { ensureFreshAccountToken, markAccountReauthRequired } from '../src/services/tokenHealthService.js';
import { checkYoutubeAuthorizations, purgeRevokedYoutubeAccounts } from '../src/services/revokedAccountCleanupService.js';

const accountDocument = (platform = 'youtube') => ({
  _id: 'account', platform, name: 'Channel', accessToken: 'test-token', isConnected: true,
  tokenExpiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
  set(updates) { Object.assign(this, updates); },
  async save() { return this; },
});

test('YouTube authorization failures disable the connection and mark data for cleanup', async () => {
  const account = accountDocument();
  await markAccountReauthRequired(account, 'Consent revoked');
  assert.equal(account.isConnected, false);
  assert.equal(account.tokenStatus, 'reauth_required');
  assert.ok(account.providerDataDeletionPendingAt instanceof Date);
  await assert.rejects(ensureFreshAccountToken(account), /requires reauthorization/);
  const meta = accountDocument('instagram');
  await markAccountReauthRequired(meta);
  assert.equal(meta.providerDataDeletionPendingAt, undefined);
});

test('authorization failures during asynchronous channel profile refresh also schedule cleanup', async (t) => {
  const account = accountDocument();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid credentials' } }) }));
  await assert.rejects(ensureFreshAccountToken(account), /Invalid credentials/);
  assert.equal(account.isConnected, false);
  assert.ok(account.providerDataDeletionPendingAt instanceof Date);
});

test('temporary provider failures do not schedule deletion of authorized data', async (t) => {
  const account = accountDocument();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network unavailable'); });
  await assert.rejects(ensureFreshAccountToken(account), /Network unavailable/);
  assert.equal(account.isConnected, true);
  assert.equal(account.providerDataDeletionPendingAt, undefined);
});

test('authorization checks force a refresh and continue past a failed channel', async (t) => {
  t.mock.method(SocialAccount, 'find', async (filter) => {
    assert.deepEqual(filter, { platform: 'youtube', isConnected: true });
    return [{ _id: 'a' }, { _id: 'b' }];
  });
  const checked = [];
  await checkYoutubeAuthorizations({ refresh: async (account, options) => {
    checked.push(account._id);
    assert.equal(options.force, true);
    if (account._id === 'a') throw new Error('invalid_grant');
  } });
  assert.deepEqual(checked, ['a', 'b']);
});

test('cleanup includes legacy disconnected records, retries failures and avoids re-revoking Google', async (t) => {
  t.mock.method(SocialAccount, 'find', (filter) => {
    assert.equal(filter.platform, 'youtube');
    assert.deepEqual(filter.$or[1], { isConnected: false, tokenStatus: 'reauth_required' });
    return { select: async () => [{ _id: 'a' }, { _id: 'b' }] };
  });
  t.mock.method(console, 'error', () => {});
  let failing = true;
  const purge = async (ids, options) => {
    assert.equal(options.revokeProviderAccess, false);
    if (ids[0] === 'a' && failing) throw new Error('Storage temporarily unavailable');
    return { accountsDeleted: 1 };
  };
  assert.equal(await purgeRevokedYoutubeAccounts({ purge }), 1);
  failing = false;
  assert.equal(await purgeRevokedYoutubeAccounts({ purge }), 2);
});
