import mongoose from 'mongoose';
import { encryptToken, decryptToken, isEncryptionEnabled } from '../utils/tokenEncryption.js';

const SocialAccountSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    index: true,
  },
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'youtube'],
    required: true,
  },
  accountId: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  username: {
    type: String,
  },
  accessToken: {
    type: String,
    required: true,
  },
  authProvider: {
    type: String,
    enum: ['facebook', 'instagram', 'youtube'],
    default: 'facebook',
  },
  refreshToken: {
    type: String,
  },
  tokenExpiresAt: {
    type: Date,
  },
  tokenStatus: {
    type: String,
    enum: ['unknown', 'healthy', 'expiring', 'expired', 'reauth_required'],
    default: 'unknown',
  },
  tokenLastCheckedAt: {
    type: Date,
  },
  tokenRefreshError: {
    type: String,
    default: '',
  },
  scopes: [String],
  analyticsStatus: {
    type: String,
    enum: ['unknown', 'healthy', 'permission_missing', 'unavailable'],
    default: 'unknown',
  },
  analyticsError: {
    type: String,
    default: '',
  },
  analyticsLastCheckedAt: {
    type: Date,
  },
  avatarUrl: {
    type: String,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  isConnected: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// Encrypt tokens before saving to database
SocialAccountSchema.pre('save', function (next) {
  if (isEncryptionEnabled()) {
    if (this.isModified('accessToken') && this.accessToken && !this.accessToken.startsWith('enc:')) {
      this.accessToken = encryptToken(this.accessToken);
    }
    if (this.isModified('refreshToken') && this.refreshToken && !this.refreshToken.startsWith('enc:')) {
      this.refreshToken = encryptToken(this.refreshToken);
    }
  }
  next();
});

// Instance method to get decrypted access token
SocialAccountSchema.methods.getDecryptedAccessToken = function () {
  return decryptToken(this.accessToken);
};

// Instance method to get decrypted refresh token
SocialAccountSchema.methods.getDecryptedRefreshToken = function () {
  return this.refreshToken ? decryptToken(this.refreshToken) : null;
};

SocialAccountSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.accessToken;
    delete ret.refreshToken;
    return ret;
  },
});

// Same platform account can be connected by different users, but not duplicated for the same user
SocialAccountSchema.index({ userId: 1, accountId: 1 }, { unique: true });
SocialAccountSchema.index({ campaignId: 1, userId: 1, isConnected: 1 });

export const sanitizeSocialAccount = (account) => {
  if (!account) return account;
  if (Array.isArray(account)) {
    return account.map(sanitizeSocialAccount);
  }
  const plain = typeof account.toObject === 'function' ? account.toObject() : { ...account };
  delete plain.accessToken;
  delete plain.refreshToken;
  return plain;
};

export default mongoose.models.SocialAccount || mongoose.model('SocialAccount', SocialAccountSchema);
