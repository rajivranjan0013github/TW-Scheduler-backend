import mongoose from 'mongoose';

const ACTION_STATUSES = ['pending', 'sent', 'failed', 'skipped'];

const AutomationEventSchema = new mongoose.Schema({
  ruleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationRule',
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  socialAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
  },
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'youtube'],
    default: 'instagram',
  },
  commentId: {
    type: String,
    required: true,
  },
  youtubeDataExpiresAt: { type: Date },
  mediaId: {
    type: String,
    default: '',
  },
  commenterId: {
    type: String,
    default: '',
  },
  commenterUsername: {
    type: String,
    default: '',
  },
  commentText: {
    type: String,
    default: '',
  },
  replyStatus: {
    type: String,
    enum: ACTION_STATUSES,
    default: 'skipped',
  },
  replyText: {
    type: String,
    default: '',
  },
  dmStatus: {
    type: String,
    enum: ACTION_STATUSES,
    default: 'skipped',
  },
  error: {
    type: String,
    default: '',
  },
}, { timestamps: true });

// Meta retries webhook deliveries, so a comment must only ever be handled once per account
AutomationEventSchema.index({ platform: 1, socialAccountId: 1, commentId: 1 }, { unique: true });
AutomationEventSchema.index({ userId: 1, createdAt: -1 });
AutomationEventSchema.index({ youtubeDataExpiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.AutomationEvent || mongoose.model('AutomationEvent', AutomationEventSchema);
