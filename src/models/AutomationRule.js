import mongoose from 'mongoose';

const AutomationRuleSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  socialAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
    index: true,
  },
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'youtube'],
    default: 'instagram',
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
  },
  enabled: {
    type: Boolean,
    default: true,
  },
  // Comments posted before this moment never trigger the rule, so turning it on
  // doesn't reply to old comments or ones left while it was off.
  enabledAt: {
    type: Date,
  },
  // 'all' fires on every post of the account, 'specific' only on mediaIds
  mediaScope: {
    type: String,
    enum: ['all', 'specific'],
    default: 'all',
  },
  mediaIds: {
    type: [String],
    default: [],
  },
  // 'any' fires on every comment, 'keywords' only when a keyword appears in the comment
  triggerType: {
    type: String,
    enum: ['any', 'keywords'],
    default: 'keywords',
  },
  keywords: {
    type: [String],
    default: [],
  },
  // One of these is picked at random so public replies don't all look identical
  commentReplies: {
    type: [String],
    default: [],
  },
  sendDm: {
    type: Boolean,
    default: false,
  },
  dmMessage: {
    type: String,
    default: '',
    maxlength: 1000,
  },
  triggeredCount: {
    type: Number,
    default: 0,
  },
  lastTriggeredAt: {
    type: Date,
  },
}, { timestamps: true });

AutomationRuleSchema.pre('save', function setEnabledAt() {
  if (this.enabled && (this.isNew || this.isModified('enabled'))) this.enabledAt = new Date();
});

AutomationRuleSchema.index({ socialAccountId: 1, enabled: 1 });

export default mongoose.models.AutomationRule || mongoose.model('AutomationRule', AutomationRuleSchema);
