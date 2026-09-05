import mongoose from 'mongoose';

const MediaSourceUsageSchema = new mongoose.Schema({
  firstVideoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
    default: null,
  },
  secondVideoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
    default: null,
  },
  musicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
    default: null,
  },
  text: {
    type: String,
    default: '',
  },
}, { _id: false });

const MediaSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    index: true,
  },
  scope: {
    type: String,
    enum: ['campaign', 'global', 'personal'],
    default: 'campaign',
    index: true,
  },
  folderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null,
  },
  socialAccountIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    index: true,
  }],
  name: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['video', 'image', 'thumbnail', 'audio'],
    required: true,
  },
  url: {
    type: String,
    required: true,
  },
  storageKey: {
    type: String,
    required: true,
  },
  thumbnailUrl: {
    type: String,
    default: '',
  },
  thumbnailStorageKey: {
    type: String,
    default: '',
  },
  thumbnailGeneratedAt: {
    type: Date,
  },
  caption: {
    type: String,
    default: '',
  },
  visualSummary: {
    type: String,
    default: '',
  },
  visualTags: [String],
  visualAnalyzedAt: {
    type: Date,
    default: null,
  },
  sourceUsage: {
    type: MediaSourceUsageSchema,
    default: () => ({}),
  },
  uploadBatchId: {
    type: String,
    default: '',
    index: true,
  },
  uploadBatchCreatedAt: {
    type: Date,
  },
  uploadOrder: {
    type: Number,
  },
  tags: [String],
  size: {
    type: Number,
  },
  aiStatus: {
    type: String,
    enum: ['none', 'pending', 'processing', 'completed', 'failed'],
    default: 'none',
    index: true,
  },
  aiProcessedAt: {
    type: Date,
  },
  aiError: {
    type: String,
    default: '',
  },
  aiAnalysis: {
    type: new mongoose.Schema({
      summary: { type: String, default: '' },
      reaction: {
        primaryEmotion: { type: String, default: '' },
        description: { type: String, default: '' },
        openingDialogue: { type: String, default: '' },
      },
      hook: {
        detected: { type: Boolean, default: false },
        description: { type: String, default: '' },
        hookConcept: { type: String, default: '' },
        openingDialogue: { type: String, default: '' },
      },
      appShowcase: {
        detected: { type: Boolean, default: false },
        featuresShown: { type: [String], default: [] },
        screenDetails: { type: String, default: '' },
        userFlow: { type: [String], default: [] },
        strongestMoments: { type: [String], default: [] },
        suggestedOverlays: { type: [String], default: [] },
        confidence: { type: String, default: '' },
      },
      autoTags: { type: [String], default: [] },
    }, { _id: false }),
    default: () => ({}),
  },
}, { timestamps: true });

MediaSchema.index({ campaignId: 1, folderId: 1, uploadBatchCreatedAt: -1, uploadOrder: 1, createdAt: -1 });
MediaSchema.index({ campaignId: 1, folderId: 1, createdAt: -1 });
MediaSchema.index({ campaignId: 1, socialAccountIds: 1, createdAt: -1 });
MediaSchema.index({ campaignId: 1, userId: 1 });
MediaSchema.index({ scope: 1, folderId: 1, createdAt: -1 });
MediaSchema.index({ scope: 1, userId: 1, createdAt: -1 });

export default mongoose.models.Media || mongoose.model('Media', MediaSchema);
