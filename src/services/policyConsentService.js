import User from '../models/User.js';
import { currentPolicyConsentFilter, LEGAL_POLICY_VERSION } from '../config/legalPolicy.js';

export const recordPolicyConsent = async (userId, { version, accepted } = {}) => {
  if (version !== LEGAL_POLICY_VERSION || accepted !== true) {
    const error = new Error('Review the current Privacy Policy and Terms and confirm your acceptance.');
    error.statusCode = 400;
    throw error;
  }
  return User.findByIdAndUpdate(userId, {
    $set: { policyConsent: { version: LEGAL_POLICY_VERSION, acceptedAt: new Date() } },
  }, { returnDocument: 'after', runValidators: true });
};

export const hasAccountPolicyConsent = async (account) => Boolean(account?.userId && await User.exists({
  _id: account.userId,
  ...currentPolicyConsentFilter(),
}));

export const requireAccountPolicyConsent = async (account) => {
  if (await hasAccountPolicyConsent(account)) return;
  const error = new Error('The channel owner must accept the updated Privacy Policy and Terms before comments and messaging can be used.');
  error.statusCode = 403;
  error.code = 'POLICY_CONSENT_REQUIRED';
  throw error;
};
