import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import User from '../models/User.js';
import router from '../routes/accounts.js';

const test = async () => {
  try {
    await connectDB();
    const user = await User.findOne({ email: /ayushcursor1/i }).lean();

    const req = {
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        userType: user.userType
      }
    };

    let responseData = null;
    const res = {
      status(code) {
        return {
          json(data) {
            responseData = data;
          }
        };
      }
    };

    // Find the matching route handler manually from accounts.js
    const route = router.stack.find(s => s.route && s.route.path === '/creator/campaigns');
    const handler = route.route.stack[1].handle;

    await handler(req, res);

   
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
  }
};

test();
