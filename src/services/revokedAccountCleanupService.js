import SocialAccount from '../models/SocialAccount.js';
import { getDBStatus } from '../config/db.js';
import { purgeSocialAccounts } from './dataPurgeService.js';
import { ensureFreshAccountToken } from './tokenHealthService.js';

const AUTH_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
let maintenanceInterval;
let maintenanceRunning = false;
let lastAuthorizationCheck = 0;

export const checkYoutubeAuthorizations = async ({ refresh = ensureFreshAccountToken } = {}) => {
  const accounts = await SocialAccount.find({ platform: 'youtube', isConnected: true });
  for (const account of accounts) {
    if (account.accessToken?.startsWith('mock-')) continue;
    try {
      // Refresh even a valid access token to detect consent revoked at Google.
      await refresh(account, { force: true });
    } catch {
      // Definitive authorization failures are marked for deletion by tokenHealthService.
      // Temporary network/provider failures leave the connection and data intact.
    }
  }
};

export const purgeRevokedYoutubeAccounts = async ({ purge = purgeSocialAccounts } = {}) => {
  const accounts = await SocialAccount.find({
    platform: 'youtube',
    $or: [
      { providerDataDeletionPendingAt: { $ne: null } },
      { isConnected: false, tokenStatus: 'reauth_required' },
    ],
  }).select('_id');
  let deleted = 0;
  for (const account of accounts) {
    try {
      const result = await purge([account._id], { revokeProviderAccess: false });
      deleted += result.accountsDeleted;
    } catch {
      // Leave the disconnected account in place so the next pass can retry.
      console.error('[Privacy cleanup] Revoked YouTube data could not be fully erased; retrying on the next pass.');
    }
  }
  return deleted;
};

export const runRevokedAccountMaintenance = async () => {
  if (maintenanceRunning || !getDBStatus()) return;
  maintenanceRunning = true;
  try {
    if (Date.now() - lastAuthorizationCheck >= AUTH_CHECK_INTERVAL_MS) {
      await checkYoutubeAuthorizations();
      lastAuthorizationCheck = Date.now();
    }
    await purgeRevokedYoutubeAccounts();
  } finally {
    maintenanceRunning = false;
  }
};

export const startRevokedAccountCleanup = async () => {
  if (maintenanceInterval) clearInterval(maintenanceInterval);
  // This runs outside comment workers: deleting from inside a running comment job
  // would wait for that same job to finish. It also runs with background sync off.
  await runRevokedAccountMaintenance();
  maintenanceInterval = setInterval(() => {
    runRevokedAccountMaintenance().catch(() => {
      console.error('[Privacy cleanup] Maintenance failed; retrying on the next pass.');
    });
  }, 60 * 1000);
  maintenanceInterval.unref();
};
