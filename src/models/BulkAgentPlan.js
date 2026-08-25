import mongoose from 'mongoose';

const BulkAgentAssetSchema = new mongoose.Schema({
  mediaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
    required: true,
  },
  name: {
    type: String,
    default: '',
  },
  type: {
    type: String,
    enum: ['video', 'audio'],
    required: true,
  },
  url: {
    type: String,
    required: true,
  },
  thumbnailUrl: {
    type: String,
    default: '',
  },
  duration: {
    type: Number,
    default: 0,
  },
}, { _id: false });

const BulkAgentTextOverlaySchema = new mongoose.Schema({
  id: { type: String, default: '' },
  text: { type: String, default: '' },
  binding: {
    type: String,
    enum: ['video1', 'video2', 'bulkVideos', 'custom'],
    default: 'video1',
  },
  start: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  style: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  position: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { _id: false });

const BulkAgentAssignmentSchema = new mongoose.Schema({
  targetRowId: {
    type: String,
    default: '',
  },
  targetIndex: {
    type: Number,
    default: null,
  },
  changedFields: [{
    type: String,
    enum: ['video1', 'video2', 'audio', 'caption', 'textOverlays'],
  }],
  clearFields: [{
    type: String,
    enum: ['audio', 'caption', 'textOverlays'],
  }],
  video1: {
    type: BulkAgentAssetSchema,
    default: null,
  },
  video2: {
    type: BulkAgentAssetSchema,
    default: null,
  },
  audio: {
    type: BulkAgentAssetSchema,
    default: null,
  },
  caption: {
    type: String,
    default: '',
  },
  textOverlays: {
    type: [BulkAgentTextOverlaySchema],
    default: [],
  },
}, { _id: false });

const BulkAgentTargetRowSchema = new mongoose.Schema({
  rowId: { type: String, required: true },
  index: { type: Number, required: true },
  video1MediaId: { type: String, default: '' },
  video2MediaId: { type: String, default: '' },
  audioMediaId: { type: String, default: '' },
  caption: { type: String, default: '' },
  textOverlays: { type: [BulkAgentTextOverlaySchema], default: [] },
}, { _id: false });

const BulkAgentMentionSchema = new mongoose.Schema({
  folderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    required: true,
  },
  name: { type: String, default: '' },
  role: {
    type: String,
    enum: ['primary', 'secondary', 'audio', 'unspecified'],
    default: 'unspecified',
  },
}, { _id: false });

const BulkAgentBoardRowSchema = new mongoose.Schema({
  rowId: { type: String, required: true },
  index: { type: Number, required: true },
  video1MediaId: { type: String, default: '' },
  video2MediaId: { type: String, default: '' },
  audioMediaId: { type: String, default: '' },
  caption: { type: String, default: '' },
  textOverlays: { type: [BulkAgentTextOverlaySchema], default: [] },
}, { _id: false });

const BulkAgentTaskSchema = new mongoose.Schema({
  id: { type: String, required: true },
  type: {
    type: String,
    enum: [
      'createFrames', 'removeFrames', 'clearBoard',
      'setFirstVideo', 'setSecondVideo', 'setAudio', 'removeAudio',
      'addTextOverlay', 'updateTextContent', 'updateTextStyle',
      'setTextPosition', 'setTextTiming', 'removeText', 'selectMediaByContent',
    ],
    required: true,
  },
  target: {
    scope: {
      type: String,
      enum: ['board', 'newFrames', 'allFrames', 'frameNumbers', 'allCaptions'],
      required: true,
    },
    frameNumbers: [{ type: Number }],
  },
  params: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  dependsOn: [{ type: String }],
}, { _id: false });

const BulkAgentPlanSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true,
    index: true,
  },
  message: {
    type: String,
    required: true,
  },
  assistantMessage: {
    type: String,
    default: '',
  },
  operation: {
    type: String,
    enum: ['append', 'replace', 'update', 'remove', 'clear'],
    default: 'append',
  },
  status: {
    type: String,
    enum: ['pending', 'applying', 'applied', 'releasing', 'discarding', 'discarded', 'released'],
    default: 'pending',
    index: true,
  },
  assignments: {
    type: [BulkAgentAssignmentSchema],
    default: [],
  },
  tasks: {
    type: [BulkAgentTaskSchema],
    default: [],
  },
  targetRows: {
    type: [BulkAgentTargetRowSchema],
    default: [],
  },
  mentionedFolders: {
    type: [BulkAgentMentionSchema],
    default: [],
  },
  boardSnapshot: {
    type: [BulkAgentBoardRowSchema],
    default: [],
  },
  isDualVideo: {
    type: Boolean,
    required: true,
    default: true,
  },
  cooldownDays: {
    type: Number,
    required: true,
    min: 0,
    max: 3650,
    default: 30,
  },
  allowReuse: {
    type: Boolean,
    required: true,
    default: false,
  },
  transitionStartedAt: {
    type: Date,
    default: null,
  },
  transitionFromStatus: {
    type: String,
    default: '',
  },
  releaseIntent: {
    sourceMediaIds: [{ type: String }],
    releaseAll: { type: Boolean, default: false },
    discard: { type: Boolean, default: false },
  },
  availability: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },
  summary: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },
  warnings: {
    type: [String],
    default: [],
  },
  expiresAt: {
    type: Date,
    required: true,
  },
}, { timestamps: true });

BulkAgentPlanSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
BulkAgentPlanSchema.index({ campaignId: 1, status: 1, expiresAt: 1 });
BulkAgentPlanSchema.index({ userId: 1, status: 1, transitionStartedAt: 1 });
BulkAgentPlanSchema.index(
  { userId: 1, campaignId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

export default mongoose.models.BulkAgentPlan
  || mongoose.model('BulkAgentPlan', BulkAgentPlanSchema);
