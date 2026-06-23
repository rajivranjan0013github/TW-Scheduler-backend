import mongoose from 'mongoose';

const SavedCaptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  text: {
    type: String,
    required: true,
    trim: true,
  },
}, { timestamps: true });

export default mongoose.models.SavedCaption || mongoose.model('SavedCaption', SavedCaptionSchema);
