import mongoose from 'mongoose';

const SocialAccountSchema = new mongoose.Schema({
  platform: {
    type: String,
    enum: ['instagram', 'facebook'],
    required: true,
  },
  accountId: {
    type: String,
    required: true,
    unique: true,
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
  avatarUrl: {
    type: String,
  },
  isConnected: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

export default mongoose.models.SocialAccount || mongoose.model('SocialAccount', SocialAccountSchema);
