import mongoose from 'mongoose';

const PostMetricDailySnapshotSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'PublishedPost', required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAccount', required: true },
  dateStr: { type: String, required: true },
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  viewsSource: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

PostMetricDailySnapshotSchema.index({ postId: 1, dateStr: 1 }, { unique: true });
PostMetricDailySnapshotSchema.index({ accountId: 1, dateStr: -1 });
PostMetricDailySnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.PostMetricDailySnapshot || mongoose.model('PostMetricDailySnapshot', PostMetricDailySnapshotSchema);
