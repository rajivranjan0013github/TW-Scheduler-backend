import mongoose from 'mongoose';

const CampaignChannelSchema = new mongoose.Schema({
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true,
    index: true,
  },
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'youtube'],
    required: true,
  },
  requestedHandle: {
    type: String,
    required: true,
    trim: true,
  },
  normalizedHandle: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true,
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
    index: true,
  },
  status: {
    type: String,
    enum: ['pending_verification', 'verified', 'disconnected', 'mismatch'],
    default: 'pending_verification',
    index: true,
  },
  addedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  assignedHandlerEmail: {
    type: String,
    default: '',
    trim: true,
    lowercase: true,
    index: true,
  },
  assignedHandlerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  verifiedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  verifiedAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

CampaignChannelSchema.index(
  { campaignId: 1, platform: 1, normalizedHandle: 1 },
  { unique: true }
);

export default mongoose.models.CampaignChannel || mongoose.model('CampaignChannel', CampaignChannelSchema);
