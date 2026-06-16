import mongoose from 'mongoose';

const FolderSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
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
}, { timestamps: true });

export default mongoose.models.Folder || mongoose.model('Folder', FolderSchema);
