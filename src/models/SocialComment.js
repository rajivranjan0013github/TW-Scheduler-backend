import mongoose from 'mongoose';

// Comments other people leave on a connected Instagram account's or Facebook Page's posts, for the Recent comments feed
const SocialCommentSchema = new mongoose.Schema({
  socialAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
  },
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'youtube'],
    default: 'instagram',
  },
  commentId: {
    type: String,
    required: true,
  },
  mediaId: {
    type: String,
    default: '',
  },
  // Set when this is a reply inside another comment's thread
  parentId: {
    type: String,
    default: '',
  },
  text: {
    type: String,
    default: '',
  },
  // Instagram @handle; empty on Facebook, which only exposes a display name
  username: {
    type: String,
    default: '',
  },
  name: {
    type: String,
    default: '',
  },
  commentedAt: {
    type: Date,
    required: true,
  },
  ownerReplied: {
    type: Boolean,
    default: false,
  },
  // Not yet seen in the Recent comments feed
  unseen: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

SocialCommentSchema.index({ socialAccountId: 1, commentId: 1 }, { unique: true });
SocialCommentSchema.index({ socialAccountId: 1, commentedAt: -1 });

export default mongoose.models.SocialComment || mongoose.model('SocialComment', SocialCommentSchema);
