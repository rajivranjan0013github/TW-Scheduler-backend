import mongoose from 'mongoose';

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

// Same platform account can be connected by different users, but not duplicated for the same user
SocialAccountSchema.index({ userId: 1, accountId: 1 }, { unique: true });

export default mongoose.models.SocialAccount || mongoose.model('SocialAccount', SocialAccountSchema);
