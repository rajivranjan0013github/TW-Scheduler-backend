import mongoose from 'mongoose';

const MetricSyncStatusSchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAccount', required: true },
  tier: { type: String, enum: ['hot', 'warm', 'daily', 'manual'], required: true },
  status: { type: String, enum: ['queued', 'running', 'success', 'partial', 'rate_limited', 'failed'], default: 'queued' },
  lastAttemptAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
  postsProcessed: { type: Number, default: 0 },
}, { timestamps: true });

MetricSyncStatusSchema.index({ accountId: 1, tier: 1 }, { unique: true });

export default mongoose.models.MetricSyncStatus || mongoose.model('MetricSyncStatus', MetricSyncStatusSchema);
