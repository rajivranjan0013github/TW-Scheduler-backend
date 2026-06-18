import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

let redisConnection = null;
let isRedisConnected = false;

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || 6379;
const redisPassword = process.env.REDIS_PASSWORD || null;

export const connectRedis = () => {
  if (process.env.DEMO_MODE === 'true' || !process.env.REDIS_HOST) {
    return null;
  }

  try {
    const opts = {
      maxRetriesPerRequest: null,
      host: redisHost,
      port: redisPort,
    };
    if (redisPassword) {
      opts.password = redisPassword;
    }

    redisConnection = new IORedis(opts);

    redisConnection.on('connect', () => {
      isRedisConnected = true;
    });

    redisConnection.on('error', (err) => {
      console.error('❌ Redis connection error:', err.message);
      isRedisConnected = false;
    });

    return redisConnection;
  } catch (error) {
    console.error('❌ Failed to initialize Redis connection:', error.message);
    isRedisConnected = false;
    return null;
  }
};

export const getRedisStatus = () => isRedisConnected;
export const getRedisConnection = () => redisConnection;
export { Queue, Worker };
