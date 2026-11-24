const normalizeEmail = (email = '') => email.trim().toLowerCase();

/**
 * Campaigns an admin-panel user may see. Owners see every campaign unless they ask for
 * their own workspace (`forceWorkspaceScope`); everyone else sees the campaigns they
 * created or are the main contact for.
 */
export const getCampaignAccessQuery = (req, { forceWorkspaceScope = false } = {}) => {
  if (req.user?.role === 'owner' && !forceWorkspaceScope) return {};

  const userEmail = normalizeEmail(req.user?.email || '');
  return {
    $or: [
      { mainEmail: userEmail },
      { createdBy: req.user._id },
    ],
  };
};
