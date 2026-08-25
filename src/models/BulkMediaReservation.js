import mongoose from 'mongoose';

const BulkMediaReservationSchema = new mongoose.Schema({
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
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BulkAgentPlan',
    required: true,
    index: true,
  },
  sourceMediaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media',
    required: true,
  },
  role: {
    type: String,
    enum: ['video1', 'video2', 'audio'],
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
}, { timestamps: true });

BulkMediaReservationSchema.index(
  { campaignId: 1, sourceMediaId: 1 },
  { unique: true },
);
BulkMediaReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.BulkMediaReservation
  || mongoose.model('BulkMediaReservation', BulkMediaReservationSchema);
