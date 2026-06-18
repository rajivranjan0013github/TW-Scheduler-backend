import mongoose from 'mongoose';

const InsightSchema = new mongoose.Schema({
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
    index: true,
  },
  dateStr: {
    type: String,
    required: true,
    index: true,
  },
  platform: {
    type: String,
    required: true,
  },
  value: {
    type: Number,
    default: 0,
  }
}, { timestamps: true });

// Prevent duplicate cached entries for the same account on the same day
InsightSchema.index({ accountId: 1, dateStr: 1 }, { unique: true });

export default mongoose.models.Insight || mongoose.model('Insight', InsightSchema);
