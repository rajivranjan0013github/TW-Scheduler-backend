import mongoose from 'mongoose';

const PostMetricSnapshotSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'PublishedPost', required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAccount', required: true },
  capturedAt: { type: Date, required: true },
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  viewDelta: { type: Number, default: 0 },
  likeDelta: { type: Number, default: 0 },
  commentDelta: { type: Number, default: 0 },
  viewsSource: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

PostMetricSnapshotSchema.index({ postId: 1, capturedAt: 1 }, { unique: true });
PostMetricSnapshotSchema.index({ accountId: 1, capturedAt: -1 });
PostMetricSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.PostMetricSnapshot || mongoose.model('PostMetricSnapshot', PostMetricSnapshotSchema);
