import mongoose from 'mongoose';

const OAuthStateNonceSchema = new mongoose.Schema({
  nonce: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['facebook', 'instagram', 'youtube'], required: true },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
}, { timestamps: true });

OAuthStateNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.OAuthStateNonce
  || mongoose.model('OAuthStateNonce', OAuthStateNonceSchema);
