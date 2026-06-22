import express from 'express';
import { getDBStatus } from '../config/db.js';
import { protect, authorize } from '../middleware/auth.js';
import User from '../models/User.js';
import SocialAccount from '../models/SocialAccount.js';
import ScheduledPost from '../models/ScheduledPost.js';
import PublishedPost from '../models/PublishedPost.js';
import Media from '../models/Media.js';
import Folder from '../models/Folder.js';
import Insight from '../models/Insight.js';
import PostInsight from '../models/PostInsight.js';
import Campaign from '../models/Campaign.js';

const router = express.Router();
const VALID_ROLES = ['owner', 'admin', 'editor', 'viewer'];

const toKey = (value) => value?.toString();

const buildCountMap = (rows, valueKey = 'count') => {
  const map = new Map();
  rows.forEach((row) => {
    map.set(toKey(row._id), row[valueKey] || 0);
  });
  return map;
};

const buildStatusMap = (rows) => {
  const map = new Map();
  rows.forEach((row) => {
    const userId = toKey(row._id.userId);
    if (!map.has(userId)) {
      map.set(userId, {});
    }
    map.get(userId)[row._id.status] = row.count;
  });
  return map;
};

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const dateKey = (date) => startOfDay(date).toISOString().split('T')[0];
const getLast7DayActivity = (now = new Date()) => {
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return Array.from({ length: 7 }, (_, index) => {
    const date = startOfDay(now);
    date.setDate(date.getDate() - index);
    return {
      dateStr: dateKey(date),
      label: dayLabels[date.getDay()],
      count: 0,
      posts: [],
    };
  });
};

const getCampaignMetrics = async (campaign) => {
  const scopedAccounts = await SocialAccount.find({ campaignId: campaign._id })
    .populate('userId', 'name email')
    .sort({ name: 1 })
    .lean();
  const accountIds = scopedAccounts.map((account) => account._id);
  const accountDetails = scopedAccounts.map((account) => {
    const plain = account.toObject ? account.toObject() : account;
    return {
      _id: plain._id,
      name: plain.name || 'Unknown account',
      username: plain.username || '',
      platform: plain.platform || '',
      avatarUrl: plain.avatarUrl || '',
      isConnected: Boolean(plain.isConnected),
      tokenExpiresAt: plain.tokenExpiresAt || null,
      user: plain.userId && typeof plain.userId === 'object'
        ? {
          _id: plain.userId._id,
          name: plain.userId.name || '',
          email: plain.userId.email || '',
        }
        : null,
    };
  });

  if (accountIds.length === 0) {
    return {
      accounts: 0,
      posts: 0,
      todayPosts: 0,
      yesterdayPosts: 0,
      last7DaysPosts: 0,
      thisMonthPosts: 0,
      lifetimeViews: 0,
      lifetimeAccountInsight: 0,
      todayViews: 0,
      todayAccountInsight: 0,
      yesterdayViews: 0,
      yesterdayAccountInsight: 0,
      last7DaysViews: 0,
      last7DaysAccountInsight: 0,
      thisMonthViews: 0,
      thisMonthAccountInsight: 0,
      latestLikes: 0,
      latestComments: 0,
      todayLikes: 0,
      todayComments: 0,
      yesterdayLikes: 0,
      yesterdayComments: 0,
      last7DaysLikes: 0,
      last7DaysComments: 0,
      thisMonthLikes: 0,
      thisMonthComments: 0,
      accountRows: [],
    };
  }

  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = startOfDay(now);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const last7DayActivityTemplate = getLast7DayActivity(now);
  const sevenDaysAgo = startOfDay(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const posts = await PublishedPost.find({ accountId: { $in: accountIds } })
    .select('_id accountId publishedAt latestViews latestLikes latestComments')
    .lean();

  const accountRowsMap = new Map(accountDetails.map((account) => [
    toKey(account._id),
    {
      ...account,
      posts: 0,
      todayPosts: 0,
      yesterdayPosts: 0,
      last7DaysPosts: 0,
      thisMonthPosts: 0,
      lifetimeViews: 0,
      lifetimeAccountInsight: 0,
      todayViews: 0,
      todayAccountInsight: 0,
      yesterdayViews: 0,
      yesterdayAccountInsight: 0,
      last7DaysViews: 0,
      last7DaysAccountInsight: 0,
      thisMonthViews: 0,
      thisMonthAccountInsight: 0,
      latestLikes: 0,
      latestComments: 0,
      todayLikes: 0,
      todayComments: 0,
      yesterdayLikes: 0,
      yesterdayComments: 0,
      last7DaysLikes: 0,
      last7DaysComments: 0,
      thisMonthLikes: 0,
      thisMonthComments: 0,
      last7DaysActivity: last7DayActivityTemplate.map((day) => ({ ...day })),
    },
  ]));

  const accountInsights = await Insight.find({ accountId: { $in: accountIds } }).lean();
  const accountInsightTotals = accountInsights.reduce((map, insight) => {
    const accountId = toKey(insight.accountId);
    if (!map.has(accountId)) {
      map.set(accountId, {
        lifetimeAccountInsight: 0,
        todayAccountInsight: 0,
        yesterdayAccountInsight: 0,
        last7DaysAccountInsight: 0,
        thisMonthAccountInsight: 0,
      });
    }

    const totals = map.get(accountId);
    const value = Number(insight.value || 0);
    const insightDate = insight.dateStr ? new Date(`${insight.dateStr}T00:00:00.000Z`) : null;

    totals.lifetimeAccountInsight += value;
    if (insight.dateStr === dateKey(todayStart)) totals.todayAccountInsight += value;
    if (insight.dateStr === dateKey(yesterdayStart)) totals.yesterdayAccountInsight += value;
    if (insightDate && insightDate >= sevenDaysAgo) totals.last7DaysAccountInsight += value;
    if (insightDate && insightDate >= monthStart) totals.thisMonthAccountInsight += value;

    return map;
  }, new Map());

  accountRowsMap.forEach((row, accountId) => {
    const totals = accountInsightTotals.get(accountId);
    if (!totals) return;

    row.lifetimeAccountInsight = totals.lifetimeAccountInsight;
    row.todayAccountInsight = totals.todayAccountInsight;
    row.yesterdayAccountInsight = totals.yesterdayAccountInsight;
    row.last7DaysAccountInsight = totals.last7DaysAccountInsight;
    row.thisMonthAccountInsight = totals.thisMonthAccountInsight;
  });

  const accountInsightSummary = Array.from(accountInsightTotals.values()).reduce((sum, item) => ({
    lifetimeAccountInsight: sum.lifetimeAccountInsight + item.lifetimeAccountInsight,
    todayAccountInsight: sum.todayAccountInsight + item.todayAccountInsight,
    yesterdayAccountInsight: sum.yesterdayAccountInsight + item.yesterdayAccountInsight,
    last7DaysAccountInsight: sum.last7DaysAccountInsight + item.last7DaysAccountInsight,
    thisMonthAccountInsight: sum.thisMonthAccountInsight + item.thisMonthAccountInsight,
  }), {
    lifetimeAccountInsight: 0,
    todayAccountInsight: 0,
    yesterdayAccountInsight: 0,
    last7DaysAccountInsight: 0,
    thisMonthAccountInsight: 0,
  });

  if (posts.length === 0) {
    return {
      accounts: accountIds.length,
      posts: 0,
      todayPosts: 0,
      yesterdayPosts: 0,
      last7DaysPosts: 0,
      thisMonthPosts: 0,
      lifetimeViews: 0,
      lifetimeAccountInsight: accountInsightSummary.lifetimeAccountInsight,
      todayViews: 0,
      todayAccountInsight: accountInsightSummary.todayAccountInsight,
      yesterdayViews: 0,
      yesterdayAccountInsight: accountInsightSummary.yesterdayAccountInsight,
      last7DaysViews: 0,
      last7DaysAccountInsight: accountInsightSummary.last7DaysAccountInsight,
      thisMonthViews: 0,
      thisMonthAccountInsight: accountInsightSummary.thisMonthAccountInsight,
      latestLikes: 0,
      latestComments: 0,
      todayLikes: 0,
      todayComments: 0,
      yesterdayLikes: 0,
      yesterdayComments: 0,
      last7DaysLikes: 0,
      last7DaysComments: 0,
      thisMonthLikes: 0,
      thisMonthComments: 0,
      accountRows: Array.from(accountRowsMap.values()),
    };
  }

  const postIds = posts.map((post) => post._id);
  const minDateStr = dateKey(monthStart < sevenDaysAgo ? monthStart : sevenDaysAgo);

  const insights = await PostInsight.find({
    postId: { $in: postIds },
    dateStr: { $gte: minDateStr },
  })
    .sort({ dateStr: 1 })
    .lean();

  const insightMap = new Map();
  insights.forEach((insight) => {
    const postId = toKey(insight.postId);
    if (!insightMap.has(postId)) {
      insightMap.set(postId, []);
    }
    insightMap.get(postId).push(insight);
  });

  const periodDelta = (post, sinceDate, field, latestField) => {
    const snapshots = insightMap.get(toKey(post._id)) || [];
    if (snapshots.length === 0) {
      return post.publishedAt && new Date(post.publishedAt) >= sinceDate
        ? Number(post[latestField] || 0)
        : 0;
    }

    const current = snapshots[snapshots.length - 1]?.[field] ?? post[latestField] ?? 0;
    const baseline = snapshots.find((snapshot) => snapshot.dateStr >= dateKey(sinceDate))?.[field] ?? 0;
    const delta = Number(current || 0) - Number(baseline || 0);

    if (delta > 0) return delta;

    return post.publishedAt && new Date(post.publishedAt) >= sinceDate
      ? Number(post[latestField] || 0)
      : 0;
  };

  const periodDeltaBetween = (post, startDate, endDate, field, latestField) => {
    const snapshots = insightMap.get(toKey(post._id)) || [];
    if (snapshots.length === 0) {
      const publishedAt = post.publishedAt ? new Date(post.publishedAt) : null;
      return publishedAt && publishedAt >= startDate && publishedAt < endDate
        ? Number(post[latestField] || 0)
        : 0;
    }

    const startSnapshot = snapshots.find((snapshot) => snapshot.dateStr >= dateKey(startDate));
    const endSnapshot = snapshots.find((snapshot) => snapshot.dateStr >= dateKey(endDate));
    const startValue = Number(startSnapshot?.[field] || 0);
    const endValue = Number((endSnapshot?.[field] ?? post[latestField]) || 0);
    const delta = endValue - startValue;

    if (delta > 0) return delta;

    const publishedAt = post.publishedAt ? new Date(post.publishedAt) : null;
    return publishedAt && publishedAt >= startDate && publishedAt < endDate
      ? Number(post[latestField] || 0)
      : 0;
  };

  const isPublishedSince = (post, sinceDate) => (
    post.publishedAt && new Date(post.publishedAt) >= sinceDate
  );

  const isPublishedBetween = (post, startDate, endDate) => {
    const publishedAt = post.publishedAt ? new Date(post.publishedAt) : null;
    return publishedAt && publishedAt >= startDate && publishedAt < endDate;
  };

  const totals = posts.reduce((metrics, post) => {
    const accountId = toKey(post.accountId);
    const row = accountRowsMap.get(accountId);
    const lifetimeViews = Number(post.latestViews || 0);
    const todayViews = periodDelta(post, todayStart, 'views', 'latestViews');
    const yesterdayViews = periodDeltaBetween(post, yesterdayStart, todayStart, 'views', 'latestViews');
    const last7DaysViews = periodDelta(post, sevenDaysAgo, 'views', 'latestViews');
    const thisMonthViews = periodDelta(post, monthStart, 'views', 'latestViews');
    const latestLikes = Number(post.latestLikes || 0);
    const latestComments = Number(post.latestComments || 0);
    const todayLikes = periodDelta(post, todayStart, 'likes', 'latestLikes');
    const todayComments = periodDelta(post, todayStart, 'comments', 'latestComments');
    const yesterdayLikes = periodDeltaBetween(post, yesterdayStart, todayStart, 'likes', 'latestLikes');
    const yesterdayComments = periodDeltaBetween(post, yesterdayStart, todayStart, 'comments', 'latestComments');
    const last7DaysLikes = periodDelta(post, sevenDaysAgo, 'likes', 'latestLikes');
    const last7DaysComments = periodDelta(post, sevenDaysAgo, 'comments', 'latestComments');
    const thisMonthLikes = periodDelta(post, monthStart, 'likes', 'latestLikes');
    const thisMonthComments = periodDelta(post, monthStart, 'comments', 'latestComments');
    const publishedDateStr = post.publishedAt ? dateKey(post.publishedAt) : '';
    const todayPosts = isPublishedSince(post, todayStart) ? 1 : 0;
    const yesterdayPosts = isPublishedBetween(post, yesterdayStart, todayStart) ? 1 : 0;
    const last7DaysPosts = isPublishedSince(post, sevenDaysAgo) ? 1 : 0;
    const thisMonthPosts = isPublishedSince(post, monthStart) ? 1 : 0;

    metrics.todayPosts += todayPosts;
    metrics.yesterdayPosts += yesterdayPosts;
    metrics.last7DaysPosts += last7DaysPosts;
    metrics.thisMonthPosts += thisMonthPosts;
    metrics.lifetimeViews += lifetimeViews;
    metrics.todayViews += todayViews;
    metrics.yesterdayViews += yesterdayViews;
    metrics.last7DaysViews += last7DaysViews;
    metrics.thisMonthViews += thisMonthViews;
    metrics.latestLikes += latestLikes;
    metrics.latestComments += latestComments;
    metrics.todayLikes += todayLikes;
    metrics.todayComments += todayComments;
    metrics.yesterdayLikes += yesterdayLikes;
    metrics.yesterdayComments += yesterdayComments;
    metrics.last7DaysLikes += last7DaysLikes;
    metrics.last7DaysComments += last7DaysComments;
    metrics.thisMonthLikes += thisMonthLikes;
    metrics.thisMonthComments += thisMonthComments;

    if (row) {
      row.posts += 1;
      row.todayPosts += todayPosts;
      row.yesterdayPosts += yesterdayPosts;
      row.last7DaysPosts += last7DaysPosts;
      row.thisMonthPosts += thisMonthPosts;
      row.lifetimeViews += lifetimeViews;
      row.todayViews += todayViews;
      row.yesterdayViews += yesterdayViews;
      row.last7DaysViews += last7DaysViews;
      row.thisMonthViews += thisMonthViews;
      row.latestLikes += latestLikes;
      row.latestComments += latestComments;
      row.todayLikes += todayLikes;
      row.todayComments += todayComments;
      row.yesterdayLikes += yesterdayLikes;
      row.yesterdayComments += yesterdayComments;
      row.last7DaysLikes += last7DaysLikes;
      row.last7DaysComments += last7DaysComments;
      row.thisMonthLikes += thisMonthLikes;
      row.thisMonthComments += thisMonthComments;

      const activityDay = row.last7DaysActivity.find((day) => day.dateStr === publishedDateStr);
      if (activityDay) {
        activityDay.count += 1;
        activityDay.posts.push({
          publishedAt: post.publishedAt,
        });
      }
    }

    return metrics;
  }, {
    accounts: accountIds.length,
    posts: posts.length,
    todayPosts: 0,
    yesterdayPosts: 0,
    last7DaysPosts: 0,
    thisMonthPosts: 0,
    lifetimeViews: 0,
    lifetimeAccountInsight: Array.from(accountInsightTotals.values()).reduce((sum, item) => sum + item.lifetimeAccountInsight, 0),
    todayViews: 0,
    todayAccountInsight: Array.from(accountInsightTotals.values()).reduce((sum, item) => sum + item.todayAccountInsight, 0),
    yesterdayViews: 0,
    yesterdayAccountInsight: Array.from(accountInsightTotals.values()).reduce((sum, item) => sum + item.yesterdayAccountInsight, 0),
    last7DaysViews: 0,
    last7DaysAccountInsight: Array.from(accountInsightTotals.values()).reduce((sum, item) => sum + item.last7DaysAccountInsight, 0),
    thisMonthViews: 0,
    thisMonthAccountInsight: Array.from(accountInsightTotals.values()).reduce((sum, item) => sum + item.thisMonthAccountInsight, 0),
    latestLikes: 0,
    latestComments: 0,
    todayLikes: 0,
    todayComments: 0,
    yesterdayLikes: 0,
    yesterdayComments: 0,
    last7DaysLikes: 0,
    last7DaysComments: 0,
    thisMonthLikes: 0,
    thisMonthComments: 0,
  });

  return {
    ...totals,
    accountRows: Array.from(accountRowsMap.values()),
  };
};

const serializeCampaign = async (campaign) => {
  const campaignObject = campaign.toObject ? campaign.toObject() : campaign;
  return {
    ...campaignObject,
    metrics: await getCampaignMetrics(campaignObject),
  };
};

// @desc    List all users with admin metrics
// @route   GET /api/admin/users
// @access  Private (Owner, Admin)
router.get('/users', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const [
      users,
      accountCounts,
      connectedAccountCounts,
      accountPlatformRows,
      scheduledRows,
      publishedCounts,
      mediaRows,
    ] = await Promise.all([
      User.find().sort({ createdAt: -1 }).lean(),
      SocialAccount.aggregate([{ $group: { _id: '$userId', count: { $sum: 1 } } }]),
      SocialAccount.aggregate([
        { $match: { isConnected: true } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ]),
      SocialAccount.aggregate([
        {
          $group: {
            _id: '$userId',
            platforms: { $addToSet: '$platform' },
            tokenExpiresAt: { $min: '$tokenExpiresAt' },
          },
        },
      ]),
      ScheduledPost.aggregate([
        { $group: { _id: { userId: '$userId', status: '$status' }, count: { $sum: 1 } } },
      ]),
      PublishedPost.aggregate([{ $group: { _id: '$userId', count: { $sum: 1 } } }]),
      Media.aggregate([
        {
          $group: {
            _id: '$userId',
            count: { $sum: 1 },
            storageBytes: { $sum: { $ifNull: ['$size', 0] } },
          },
        },
      ]),
    ]);

    const accountCountMap = buildCountMap(accountCounts);
    const connectedAccountCountMap = buildCountMap(connectedAccountCounts);
    const scheduledStatusMap = buildStatusMap(scheduledRows);
    const publishedCountMap = buildCountMap(publishedCounts);

    const platformMap = new Map();
    accountPlatformRows.forEach((row) => {
      platformMap.set(toKey(row._id), {
        platforms: row.platforms || [],
        tokenExpiresAt: row.tokenExpiresAt || null,
      });
    });

    const mediaMap = new Map();
    mediaRows.forEach((row) => {
      mediaMap.set(toKey(row._id), {
        count: row.count || 0,
        storageBytes: row.storageBytes || 0,
      });
    });

    const payload = users.map((user) => {
      const userId = toKey(user._id);
      const scheduled = scheduledStatusMap.get(userId) || {};
      const media = mediaMap.get(userId) || { count: 0, storageBytes: 0 };
      const accountHealth = platformMap.get(userId) || { platforms: [], tokenExpiresAt: null };

      return {
        ...user,
        metrics: {
          accounts: accountCountMap.get(userId) || 0,
          connectedAccounts: connectedAccountCountMap.get(userId) || 0,
          scheduledPosts: scheduled.scheduled || 0,
          publishingPosts: scheduled.publishing || 0,
          publishedScheduledPosts: scheduled.published || 0,
          failedPosts: scheduled.failed || 0,
          publishedPosts: publishedCountMap.get(userId) || 0,
          media: media.count,
          storageBytes: media.storageBytes,
        },
        accountHealth,
      };
    });

    res.status(200).json(payload);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Update a user's role
// @route   PATCH /api/admin/users/:id/role
// @access  Private (Owner)
router.patch('/users/:id/role', protect, authorize('owner'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const { role } = req.body;
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Invalid role.' });
    }

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (targetUser.role === 'owner' && role !== 'owner') {
      const ownerCount = await User.countDocuments({ role: 'owner' });
      if (ownerCount <= 1) {
        return res.status(400).json({ message: 'At least one owner must remain.' });
      }
    }

    targetUser.role = role;
    await targetUser.save();

    res.status(200).json(targetUser);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete a user and their workspace data
// @route   DELETE /api/admin/users/:id
// @access  Private (Owner)
router.delete('/users/:id', protect, authorize('owner'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (toKey(targetUser._id) === toKey(req.user._id)) {
      return res.status(400).json({ message: 'You cannot delete your own admin account.' });
    }

    if (targetUser.role === 'owner') {
      const ownerCount = await User.countDocuments({ role: 'owner' });
      if (ownerCount <= 1) {
        return res.status(400).json({ message: 'At least one owner must remain.' });
      }
    }

    const [accountIds, publishedPostIds] = await Promise.all([
      SocialAccount.find({ userId: targetUser._id }).distinct('_id'),
      PublishedPost.find({ userId: targetUser._id }).distinct('_id'),
    ]);

    await Promise.all([
      PostInsight.deleteMany({ $or: [{ postId: { $in: publishedPostIds } }, { accountId: { $in: accountIds } }] }),
      Insight.deleteMany({ accountId: { $in: accountIds } }),
      SocialAccount.deleteMany({ userId: targetUser._id }),
      ScheduledPost.deleteMany({ userId: targetUser._id }),
      PublishedPost.deleteMany({ userId: targetUser._id }),
      Media.deleteMany({ userId: targetUser._id }),
      Folder.deleteMany({ userId: targetUser._id }),
      User.deleteOne({ _id: targetUser._id }),
    ]);

    res.status(200).json({ message: 'User and related workspace data deleted successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    List all folders for all users
// @route   GET /api/admin/folders
// @access  Private (Owner, Admin)
router.get('/folders', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const query = req.query.campaignId ? { campaignId: req.query.campaignId } : {};
    const folders = await Folder.find(query)
      .populate('userId', 'name email')
      .populate('campaignId', 'name mainEmail')
      .sort({ name: 1 })
      .lean();

    res.status(200).json(folders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Get folder details and its media contents
// @route   GET /api/admin/folders/:id
// @access  Private (Owner, Admin)
router.get('/folders/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const folderQuery = { _id: req.params.id };
    if (req.query.campaignId) folderQuery.campaignId = req.query.campaignId;

    const folder = await Folder.findOne(folderQuery)
      .populate('userId', 'name email')
      .populate('campaignId', 'name mainEmail')
      .lean();

    if (!folder) {
      return res.status(404).json({ message: 'Folder not found.' });
    }

    const mediaQuery = { folderId: folder._id };
    if (req.query.campaignId) mediaQuery.campaignId = req.query.campaignId;

    const media = await Media.find(mediaQuery)
      .populate('socialAccountIds', 'name username platform avatarUrl isConnected')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ folder, media });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete any folder
// @route   DELETE /api/admin/folders/:id
// @access  Private (Owner, Admin)
router.delete('/folders/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const folderQuery = { _id: req.params.id };
    if (req.query.campaignId) folderQuery.campaignId = req.query.campaignId;

    const folder = await Folder.findOne(folderQuery);
    if (!folder) {
      return res.status(404).json({ message: 'Folder not found.' });
    }

    await Folder.deleteOne(folderQuery);
    // Update all media referencing this folder to null
    const mediaQuery = { folderId: req.params.id };
    if (req.query.campaignId) mediaQuery.campaignId = req.query.campaignId;
    await Media.updateMany(mediaQuery, { folderId: null });

    res.status(200).json({ message: 'Folder deleted successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    List social accounts for campaign assignment
// @route   GET /api/admin/social-accounts
// @access  Private (Owner, Admin)
router.get('/social-accounts', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const accounts = await SocialAccount.find()
      .populate('userId', 'name email')
      .sort({ platform: 1, name: 1 })
      .lean();

    res.status(200).json(accounts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    List campaigns with metrics
// @route   GET /api/admin/campaigns
// @access  Private (Owner, Admin)
router.get('/campaigns', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const campaigns = await Campaign.find()
      .populate({
        path: 'accountIds',
        select: 'name username platform avatarUrl isConnected tokenExpiresAt userId',
        populate: { path: 'userId', select: 'name email' },
      })
      .populate('createdBy', 'name email')
      .sort({ updatedAt: -1 });

    const payload = await Promise.all(campaigns.map((campaign) => serializeCampaign(campaign)));
    res.status(200).json(payload);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Create campaign
// @route   POST /api/admin/campaigns
// @access  Private (Owner, Admin)
router.post('/campaigns', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const {
      name,
      description = '',
      productName = '',
      productWebsite = '',
      targetAudience = '',
      primaryGoal = '',
      mainEmail = req.user.email || '',
      status = 'active',
      accountIds = [],
    } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ message: 'Campaign name is required.' });
    }

    const validAccounts = await SocialAccount.find({ _id: { $in: accountIds } }).select('_id');

    const campaign = await Campaign.create({
      name: name.trim(),
      description,
      productName,
      productWebsite,
      targetAudience,
      primaryGoal,
      mainEmail: mainEmail.trim().toLowerCase(),
      status,
      accountIds: validAccounts.map((account) => account._id),
      createdBy: req.user._id,
    });

    const populated = await Campaign.findById(campaign._id)
      .populate({
        path: 'accountIds',
        select: 'name username platform avatarUrl isConnected tokenExpiresAt userId',
        populate: { path: 'userId', select: 'name email' },
      })
      .populate('createdBy', 'name email');

    res.status(201).json(await serializeCampaign(populated));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Update campaign
// @route   PATCH /api/admin/campaigns/:id
// @access  Private (Owner, Admin)
router.patch('/campaigns/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    const { name, description, productName, productWebsite, targetAudience, primaryGoal, mainEmail, status, accountIds } = req.body;

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ message: 'Campaign name is required.' });
      }
      campaign.name = name.trim();
    }

    if (description !== undefined) campaign.description = description;
    if (productName !== undefined) campaign.productName = productName;
    if (productWebsite !== undefined) campaign.productWebsite = productWebsite;
    if (targetAudience !== undefined) campaign.targetAudience = targetAudience;
    if (primaryGoal !== undefined) campaign.primaryGoal = primaryGoal;
    if (mainEmail !== undefined) campaign.mainEmail = mainEmail.trim().toLowerCase();
    if (status !== undefined) campaign.status = status;

    if (Array.isArray(accountIds)) {
      const validAccounts = await SocialAccount.find({ _id: { $in: accountIds } }).select('_id');
      campaign.accountIds = validAccounts.map((account) => account._id);
    }

    await campaign.save();

    const populated = await Campaign.findById(campaign._id)
      .populate({
        path: 'accountIds',
        select: 'name username platform avatarUrl isConnected tokenExpiresAt userId',
        populate: { path: 'userId', select: 'name email' },
      })
      .populate('createdBy', 'name email');

    res.status(200).json(await serializeCampaign(populated));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete campaign
// @route   DELETE /api/admin/campaigns/:id
// @access  Private (Owner)
router.delete('/campaigns/:id', protect, authorize('owner'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    await Campaign.deleteOne({ _id: campaign._id });
    res.status(200).json({ message: 'Campaign deleted successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
