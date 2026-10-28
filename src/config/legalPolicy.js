export const LEGAL_POLICY_VERSION = '2026-10-26';

export const hasCurrentPolicyConsent = (user) => (
  user?.policyConsent?.version === LEGAL_POLICY_VERSION
  && Boolean(user.policyConsent.acceptedAt)
);

export const currentPolicyConsentFilter = () => ({
  'policyConsent.version': LEGAL_POLICY_VERSION,
  'policyConsent.acceptedAt': { $type: 'date' },
});
