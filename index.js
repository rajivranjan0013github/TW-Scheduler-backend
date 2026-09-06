import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// Fail fast if critical secrets are missing
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required. Server cannot start without it.');
  process.exit(1);
}

// Import configurations and connections
import { connectDB } from './src/config/db.js';
import { connectRedis } from './src/config/redis.js';
import { initQueue } from './src/queues/publisherQueue.js';
import { initWorker, publishPostJob } from './src/queues/publisherWorker.js';

// Import route files
import authRoutes from './src/routes/auth.js';
import accountRoutes from './src/routes/accounts.js';
import mediaRoutes from './src/routes/media.js';
import schedulerRoutes, { startCreatorAutoCheckInterval } from './src/routes/scheduler.js';
import adminRoutes from './src/routes/admin.js';
import aiRoutes from './src/routes/ai.js';
import bulkAgentRoutes from './src/routes/bulkAgent.js';
import { protect } from './src/middleware/auth.js';
import ScheduledPost from './src/models/ScheduledPost.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { assertTokenEncryptionConfigured } from './src/utils/tokenEncryption.js';

assertTokenEncryptionConfigured();

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
});

const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
});

// Configure __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://thousandpost.com,https://www.thousandpost.com,http://localhost:5173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. server-to-server, mobile apps, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://thousandpost.com', 'https://www.thousandpost.com', 'https://media.thousandpost.com'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.facebook.com', 'https://www.instagram.com'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// Serve uploads statically for local file uploads fallback
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), {
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// Routes mapping
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/accounts', oauthLimiter, accountRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/scheduler', schedulerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/bulk-agent', bulkAgentRoutes);

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

// Serve frontend static assets from ../TW-Scheduler/dist
const frontendBuildPath = path.join(__dirname, '../TW-Scheduler/dist');
app.use(express.static(frontendBuildPath));

// All other GET requests not handled by API routes should serve index.html
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  const isCorsError = err?.message === 'Not allowed by CORS';
  res.status(isCorsError ? 403 : 500).json({
    error: 'Internal Server Error',
    message: isCorsError ? 'Origin is not allowed.' : 'An unexpected server error occurred.'
  });
});

// Start application connections & server
export const startServer = async () => {
  // 1. Connect MongoDB
  const databaseReady = await connectDB();
  if (!databaseReady && process.env.NODE_ENV === 'production') {
    throw new Error('Production startup aborted because MongoDB is unavailable.');
  }

  // 2. Connect Redis
  connectRedis();

  // 3. Initialize background worker & queue engines
  await initQueue();
  initWorker();
  startCreatorAutoCheckInterval();

  // 4. Listen on PORT
  app.listen(PORT, () => {
    console.log(`🚀 TW Creator Suite Backend running on port ${PORT}`);
  });
};

const isDirectRun = !process.argv[1] ||
  path.resolve(process.argv[1]) === __filename ||
  process.env.pm_id !== undefined ||
  process.argv[1].includes('pm2') ||
  process.argv[1].includes('ProcessContainer');

if (isDirectRun) {
  startServer();
}

export default app;
