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
  caption: {
    type: String,
    default: '',
  },
  tags: [String],
  size: {
    type: Number,
  },
}, { timestamps: true });

export default mongoose.models.Media || mongoose.model('Media', MediaSchema);
