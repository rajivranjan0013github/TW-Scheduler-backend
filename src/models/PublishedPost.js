import mongoose from 'mongoose';

const PublishedPostSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    index: true,
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
  },
  metaPostId: {
    type: String,
    required: true,
  },
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'youtube'],
    required: true,
  },
  content: {
    type: String,
    default: '',
  },
  mediaUrl: {
    type: String,
    default: '',
  },
  videoUrl: {
    type: String,
    default: '',
  },
  mediaType: {
    type: String,
    default: '',
  },
  facebookVideoId: {
    type: String,
    default: '',
  },
  viewsSource: {
    type: String,
    default: '',
  },
  permalink: {
    type: String,
    default: '',
  },
  publishedAt: {
    type: Date,
  },
  lastSyncedAt: {
    type: Date,
    default: Date.now,
  },

  // Latest lifetime metrics (updated by daily insight sync)
  latestViews: {
    type: Number,
    default: 0,
  },
  latestLikes: {
    type: Number,
    default: 0,
  },
  latestComments: {
    type: Number,
    default: 0,
  },
  commentsPreview: [{
    id: {
      type: String,
      default: '',
    },
    username: {
      type: String,
      default: '',
    },
    text: {
      type: String,
      default: '',
    },
    timestamp: {
      type: Date,
    },
  }],
}, { timestamps: true });

// Prevent duplicate posts per user
PublishedPostSchema.index({ userId: 1, metaPostId: 1 }, { unique: true });
// Fast account-level queries sorted by publish date
PublishedPostSchema.index({ accountId: 1, publishedAt: -1 });
PublishedPostSchema.index({ campaignId: 1, publishedAt: -1 });
PublishedPostSchema.index({ userId: 1, publishedAt: -1 });

export default mongoose.models.PublishedPost || mongoose.model('PublishedPost', PublishedPostSchema);
