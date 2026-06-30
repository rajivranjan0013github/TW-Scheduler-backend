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
  productName: {
    type: String,
    default: '',
    trim: true,
  },
  productWebsite: {
    type: String,
    default: '',
    trim: true,
  },
  targetAudience: {
    type: String,
    default: '',
    trim: true,
  },
  primaryGoal: {
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
  channels: [{
    platform: {
      type: String,
      enum: ['instagram', 'facebook', 'youtube'],
      required: true,
    },
    handle: {
      type: String,
      required: true,
      trim: true,
    },
    displayName: {
      type: String,
      default: '',
      trim: true,
    },
    socialAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SocialAccount',
      default: null,
    },
    assignedHandlerEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    assignedHandlerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, { timestamps: true });

CampaignSchema.index({ name: 1 });

export default mongoose.models.Campaign || mongoose.model('Campaign', CampaignSchema);
