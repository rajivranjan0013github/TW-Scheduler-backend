import mongoose from 'mongoose';

const PostInsightSchema = new mongoose.Schema({
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    index: true,
  },
  postId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PublishedPost',
    required: true,
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
  },
  dateStr: {
    type: String,
    required: true,
  },

  // Cumulative lifetime values snapshotted on this date
  views: {
    type: Number,
    default: 0,
  },
  likes: {
    type: Number,
    default: 0,
  },
  comments: {
    type: Number,
    default: 0,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// One snapshot per post per day
PostInsightSchema.index({ postId: 1, dateStr: 1 }, { unique: true });
// Fast account-level queries
PostInsightSchema.index({ accountId: 1, dateStr: 1 });
// Auto-delete after 30 days
PostInsightSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.models.PostInsight || mongoose.model('PostInsight', PostInsightSchema);
