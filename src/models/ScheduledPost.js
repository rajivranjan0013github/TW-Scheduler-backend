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
  campaignChannelIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CampaignChannel',
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
      'paused',
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
  manualAutoCheckedAt: {
    type: Date,
    default: null,
  },
  manualAutoCheckCount: {
    type: Number,
    default: 0,
  },
  manualAutoCheckError: {
    type: String,
    default: '',
  },
  manualVerificationStatus: {
    type: String,
    enum: ['pending', 'verified', 'manual_override', 'not_required', null],
    default: null,
  },
  manualVerificationError: {
    type: String,
    default: '',
  },
  cooldownBypassGrantedAt: {
    type: Date,
    default: null,
  },
  cooldownBypassGrantedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  cooldownBypassUsedAt: {
    type: Date,
    default: null,
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

ScheduledPostSchema.index({ campaignId: 1, scheduledAt: 1 });
ScheduledPostSchema.index({ socialAccountIds: 1, scheduledAt: 1 });
ScheduledPostSchema.index({ status: 1, scheduleMode: 1, scheduledAt: 1 });
ScheduledPostSchema.index({ campaignId: 1, status: 1, scheduledAt: 1 });
ScheduledPostSchema.index({ campaignId: 1, socialAccountIds: 1, status: 1, scheduledAt: 1 });
ScheduledPostSchema.index({ campaignId: 1, userId: 1, status: 1 });

export default mongoose.models.ScheduledPost || mongoose.model('ScheduledPost', ScheduledPostSchema);
