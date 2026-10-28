export const automationJobMatchesAccounts = (data, accounts) => accounts.some((account) => {
  if (data?.socialAccountId) return String(data.socialAccountId) === String(account._id);
  // Jobs queued before record references were introduced contained the webhook payload.
  const comment = data?.comment;
  return comment && (comment.platform || 'instagram') === account.platform
    && [account.accountId, account.metadata?.instagramProfessionalId]
      .filter(Boolean).map(String).includes(String(comment.entryId));
});

export const removeAutomationJobsForAccounts = async (queue, accounts, { timeoutMs = 30000 } = {}) => {
  if (!queue || !accounts.length) return;
  const jobs = await queue.getJobs([
    'waiting', 'delayed', 'active', 'completed', 'failed', 'prioritized', 'waiting-children',
  ]);
  const deadline = Date.now() + timeoutMs;
  for (const job of jobs) {
    const account = job && accounts.find((candidate) => automationJobMatchesAccounts(job.data, [candidate]));
    if (!account) continue;
    // Erase legacy text immediately, even if another worker currently holds the job lock.
    // The caller disables connections first, then waits for active work before DB deletion.
    if (await job.getState() === 'unknown') continue;
    try {
      // Keep a cancellation reference so a timed-out deletion can find active work on retry.
      await job.updateData({ socialAccountId: String(account._id), cancelled: true });
    } catch (error) {
      if (await job.getState() === 'unknown') continue;
      throw error;
    }
    while (true) {
      const state = await job.getState();
      if (state === 'unknown') break;
      if (state !== 'active') {
        try {
          await job.remove();
          break;
        } catch (error) {
          // A worker may have acquired the job between getState and remove.
          const latestState = await job.getState();
          if (latestState === 'unknown') break;
          if (latestState !== 'active') throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('An automation is still finishing. Retry the deletion request.');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};
