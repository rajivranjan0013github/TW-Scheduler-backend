import mongoose from 'mongoose';

// One Instagram DM thread between a connected account and another Instagram user
const ConversationSchema = new mongoose.Schema({
  socialAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
  },
  platform: {
    type: String,
    enum: ['instagram', 'facebook'],
    default: 'instagram',
  },
  // Instagram-scoped ID (IGSID) of the other person
  participantId: {
    type: String,
    required: true,
  },
  participantUsername: {
    type: String,
    default: '',
  },
  participantName: {
    type: String,
    default: '',
  },
  participantAvatarUrl: {
    type: String,
    default: '',
  },
  profileFetchedAt: {
    type: Date,
  },
  lastMessageText: {
    type: String,
    default: '',
  },
  lastMessageDirection: {
    type: String,
    enum: ['in', 'out', ''],
    default: '',
  },
  lastMessageAt: {
    type: Date,
  },
  // Instagram only allows replies within 24 hours of the person's last message
  lastInboundAt: {
    type: Date,
  },
  unreadCount: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });

ConversationSchema.index({ socialAccountId: 1, participantId: 1 }, { unique: true });
ConversationSchema.index({ socialAccountId: 1, lastMessageAt: -1 });

export default mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema);
