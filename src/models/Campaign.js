import mongoose from 'mongoose';

const CampaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    default: '',
    trim: true,
  },
  mainEmail: {
    type: String,
    default: '',
    trim: true,
    lowercase: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'archived'],
    default: 'active',
    index: true,
  },
  accountIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, { timestamps: true });

CampaignSchema.index({ name: 1 });

export default mongoose.models.Campaign || mongoose.model('Campaign', CampaignSchema);
