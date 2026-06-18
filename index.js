import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// Import configurations and connections
import { connectDB } from './src/config/db.js';
import { connectRedis } from './src/config/redis.js';
import { initQueue } from './src/queues/publisherQueue.js';
import { initWorker, publishPostJob } from './src/queues/publisherWorker.js';

// Import route files
import authRoutes from './src/routes/auth.js';
import accountRoutes from './src/routes/accounts.js';
import mediaRoutes from './src/routes/media.js';
import schedulerRoutes from './src/routes/scheduler.js';
import { protect } from './src/middleware/auth.js';
import ScheduledPost from './src/models/ScheduledPost.js';

// Configure __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve uploads statically for local file uploads fallback
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Routes mapping
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/scheduler', schedulerRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'TW-Scheduler API is running smoothly',
    timestamp: new Date().toISOString()
  });
});

// Direct hook endpoint to trigger background publishing (now protected)
app.post('/api/scheduler/publish-now/:id', protect, async (req, res) => {
  try {
    // Verify the post belongs to the requesting user
    const post = await ScheduledPost.findOne({ _id: req.params.id, userId: req.user._id });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    await publishPostJob(req.params.id);
    res.status(200).json({ message: 'Publishing triggered successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// Start application connections & server
const startServer = async () => {
  // 1. Connect MongoDB
  await connectDB();

  // 2. Connect Redis
  connectRedis();

  // 3. Initialize background worker & queue engines
  await initQueue();
  initWorker();

  // 4. Listen on PORT
  app.listen(PORT, () => {
    console.log(`🚀 TW Creator Suite Backend running on http://localhost:${PORT}`);
  });
};

startServer();
