import mongoose from 'mongoose';

const SyncLeaseSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

SyncLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.SyncLease || mongoose.model('SyncLease', SyncLeaseSchema);
