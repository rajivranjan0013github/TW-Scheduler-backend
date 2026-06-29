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
}, { timestamps: true });

export default mongoose.models.Folder || mongoose.model('Folder', FolderSchema);
