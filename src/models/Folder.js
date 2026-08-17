import mongoose from 'mongoose';

const FolderSchema = new mongoose.Schema({
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
    enum: ['campaign', 'global'],
    default: 'campaign',
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  parentFolderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null,
  },
  kind: {
    type: String,
    enum: ['folder', 'carousel_set'],
    default: 'folder',
    index: true,
  },
  carouselCaption: {
    type: String,
    default: '',
  },
  carouselOrder: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
  }],
  coverMediaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
    default: null,
  },
  tags: [String],
}, { timestamps: true });

FolderSchema.index({ campaignId: 1, tags: 1 });
FolderSchema.index({ scope: 1, parentFolderId: 1, name: 1 });

export default mongoose.models.Folder || mongoose.model('Folder', FolderSchema);
