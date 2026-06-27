import mongoose from 'mongoose';

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
  tags: [String],
  size: {
    type: Number,
  },
}, { timestamps: true });

MediaSchema.index({ campaignId: 1, folderId: 1, createdAt: -1 });
MediaSchema.index({ campaignId: 1, socialAccountIds: 1, createdAt: -1 });

export default mongoose.models.Media || mongoose.model('Media', MediaSchema);
