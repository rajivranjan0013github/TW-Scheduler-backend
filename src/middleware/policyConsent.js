import { hasCurrentPolicyConsent, LEGAL_POLICY_VERSION } from '../config/legalPolicy.js';

export const requireCurrentPolicyConsent = (req, res, next) => {
  // An administrator preview cannot accept legal terms on another person's behalf.
  if (hasCurrentPolicyConsent(req.user) && (!req.authenticatedUser || hasCurrentPolicyConsent(req.authenticatedUser))) {
    return next();
  }
  return res.status(403).json({
    code: 'POLICY_CONSENT_REQUIRED',
    policyVersion: LEGAL_POLICY_VERSION,
    message: 'Please review and accept the updated Privacy Policy and Terms before using comments and messaging or connecting a channel.',
  });
};
