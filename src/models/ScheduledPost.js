import mongoose from 'mongoose';

const ScheduledPostSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
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
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'publishing', 'published', 'failed'],
    default: 'scheduled',
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
