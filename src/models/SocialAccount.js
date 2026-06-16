import mongoose from 'mongoose';

const SocialAccountSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  platform: {
    type: String,
    enum: ['instagram', 'facebook'],
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
    enum: ['facebook', 'instagram'],
    default: 'facebook',
  },
  tokenExpiresAt: {
    type: Date,
  },
  avatarUrl: {
    type: String,
  },
  isConnected: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// Same platform account can be connected by different users, but not duplicated for the same user
SocialAccountSchema.index({ userId: 1, accountId: 1 }, { unique: true });

export default mongoose.models.SocialAccount || mongoose.model('SocialAccount', SocialAccountSchema);
