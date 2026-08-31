import mongoose from 'mongoose';

const CreativeBlueprintSchema = new mongoose.Schema({
  title: { type: String, default: '', trim: true },
  hook: {
    visual: { type: String, default: '', trim: true },
    direction: { type: String, default: '', trim: true },
    duration: { type: String, default: '0-2s', trim: true },
  },
  overlay: {
    text: { type: String, default: '', trim: true },
    duration: { type: String, default: '0-3s', trim: true },
    placement: { type: String, default: 'upper-third', trim: true },
  },
  showcase: {
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },
    feature: { type: String, default: '', trim: true },
    direction: { type: String, default: '', trim: true },
    startTime: { type: String, default: '', trim: true },
    endTime: { type: String, default: '', trim: true },
  },
  cta: { type: String, default: '', trim: true },
  rationale: { type: String, default: '', trim: true },
}, { _id: true });

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
  productSource: {
    type: String,
    enum: ['website', 'app_store', 'play_store'],
    default: 'website',
  },
  productUrl: {
    type: String,
    default: '',
    trim: true,
  },
  productWebsite: {
    type: String,
    default: '',
    trim: true,
  },
  productDescription: {
    type: String,
    default: '',
    trim: true,
  },
  category: {
    type: String,
    default: '',
    trim: true,
  },
  iconUrl: {
    type: String,
    default: '',
    trim: true,
  },
  targetAudience: {
    type: String,
    default: '',
    trim: true,
  },
  keyBenefit: {
    type: String,
    default: '',
    trim: true,
  },
  coreFunction: {
    type: String,
    default: '',
    trim: true,
  },
  useCases: [{
    type: String,
    trim: true,
  }],
  targetAudienceList: [{
    type: String,
    trim: true,
  }],
  marketingStrategies: [{
    type: String,
    trim: true,
  }],
  keyMessaging: [{
    type: String,
    trim: true,
  }],
  positioningStatement: {
    type: String,
    default: '',
    trim: true,
  },
  screenshots: [{
    type: String,
    trim: true,
  }],
  showcaseMediaIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
  }],
  showcaseLearning: {
    summary: { type: String, default: '', trim: true },
    featuresShown: [{ type: String, trim: true }],
    strongestMoments: [{ type: String, trim: true }],
    audienceFit: { type: String, default: '', trim: true },
    coverageGaps: [{ type: String, trim: true }],
    generatedAt: { type: Date, default: null },
  },
  creativeBlueprints: {
    type: [CreativeBlueprintSchema],
    default: [],
  },
  strategyStatus: {
    type: String,
    enum: ['none', 'generating', 'completed', 'failed'],
    default: 'none',
  },
  strategyError: {
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
  promoFolderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null,
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
