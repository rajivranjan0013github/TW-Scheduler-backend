import mongoose from 'mongoose';

const ScheduledPostSchema = new mongoose.Schema({
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
  socialAccountIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
  }],
  mediaIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
  }],
  caption: {
    type: String,
    default: '',
  },
  scheduledAt: {
    type: Date,
    required: true,
  },
  scheduleMode: {
    type: String,
    enum: ['auto', 'manual', 'hybrid'],
    default: 'auto',
    index: true,
  },
  status: {
    type: String,
    enum: [
      'draft',
      'scheduled',
      'manual_ready',
      'downloaded',
      'posted_manual',
      'publishing',
      'published',
      'published_auto',
      'failed',
      'cancelled',
    ],
    default: 'scheduled',
  },
  publishSource: {
    type: String,
    enum: ['software', 'creator', null],
    default: null,
  },
  manualDownloadedAt: {
    type: Date,
    default: null,
  },
  manualPostedAt: {
    type: Date,
    default: null,
  },
  manualPostUrl: {
    type: String,
    default: '',
  },
  postedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  publishError: {
    type: String,
  },
  publishResponseId: {
    type: String,
  },
  platformSpecifics: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true });

export default mongoose.models.ScheduledPost || mongoose.model('ScheduledPost', ScheduledPostSchema);
