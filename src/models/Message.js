import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true,
  },
  socialAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
  },
  // Instagram message ID; also how webhook echoes of our own sends are de-duplicated
  mid: {
    type: String,
    required: true,
  },
  direction: {
    type: String,
    enum: ['in', 'out'],
    required: true,
  },
  text: {
    type: String,
    default: '',
  },
  attachments: {
    type: [{ _id: false, type: { type: String }, url: String }],
    default: [],
  },
  sentAt: {
    type: Date,
    required: true,
  },
  sentByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true });

MessageSchema.index({ socialAccountId: 1, mid: 1 }, { unique: true });
MessageSchema.index({ conversationId: 1, sentAt: -1 });

export default mongoose.models.Message || mongoose.model('Message', MessageSchema);
