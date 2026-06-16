import mongoose from 'mongoose';

const MediaSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  folderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null,
  },
  name: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['video', 'image', 'thumbnail'],
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
  tags: [String],
  size: {
    type: Number,
  },
}, { timestamps: true });

export default mongoose.models.Media || mongoose.model('Media', MediaSchema);
