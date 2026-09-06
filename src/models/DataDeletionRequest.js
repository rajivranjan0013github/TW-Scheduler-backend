import crypto from 'crypto';
import mongoose from 'mongoose';

export const hashDeletionCode = (code) => (
  crypto.createHash('sha256').update(String(code || '')).digest('hex')
);

const DataDeletionRequestSchema = new mongoose.Schema({
  confirmationCodeHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  provider: {
    type: String,
    enum: ['meta', 'google', 'manual'],
    required: true,
  },
  status: {
    type: String,
    enum: ['processing', 'completed', 'failed'],
    default: 'processing',
  },
  completedAt: {
    type: Date,
    default: null,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
}, { timestamps: true });

DataDeletionRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.DataDeletionRequest
  || mongoose.model('DataDeletionRequest', DataDeletionRequestSchema);
