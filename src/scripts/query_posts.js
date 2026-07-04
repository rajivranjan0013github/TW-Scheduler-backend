import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);

  await mongoose.disconnect();
}

run().catch(console.error);
