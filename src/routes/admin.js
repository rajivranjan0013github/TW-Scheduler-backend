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
import CampaignChannel from '../models/CampaignChannel.js';
import { resolveCampaignPublishingChannels, syncCampaignChannelList } from '../utils/campaignChannels.js';
import { deleteFile } from '../services/r2Service.js';

const router = express.Router();
const VALID_ROLES = ['owner', 'admin', 'editor', 'viewer'];

const toKey = (value) => value?.toString();
const normalizeEmail = (email = '') => email.trim().toLowerCase();

const getCampaignAccessQuery = (req, { forceWorkspaceScope = false } = {}) => {
  if (req.user?.role === 'owner' && !forceWorkspaceScope) return {};

  const userEmail = normalizeEmail(req.user?.email || '');
  return {
    $or: [
      { mainEmail: userEmail },
      { createdBy: req.user._id },
    ],
  };
};

const findAccessibleCampaign = (req, campaignId) => {
  return Campaign.findOne({
    _id: campaignId,
    ...getCampaignAccessQuery(req, { forceWorkspaceScope: req.query.scope === 'workspace' }),
  });
};

const getAssignableAccountQuery = async (req, accountIds) => {
  const baseQuery = { _id: { $in: accountIds } };
  const forceWorkspaceScope = req.query.scope === 'workspace';
  if (req.user?.role === 'owner' && !forceWorkspaceScope) return baseQuery;

  const visibleCampaignIds = await Campaign.find(getCampaignAccessQuery(req, { forceWorkspaceScope })).distinct('_id');
  return {
    ...baseQuery,
    $or: [
      { userId: req.user._id },
      { campaignId: { $in: visibleCampaignIds } },
      { campaignId: { $exists: false } },
      { campaignId: null },
    ],
  };
};

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

const dateKey = (date) => {
  const d = startOfDay(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
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
  const channels = campaign.channels || [];
  const lookups = channels.map((ch) => ({
    platform: ch.platform,
    handle: ch.handle?.replace(/^@/, '').toLowerCase(),
  }));

  const orConditions = lookups.map(({ platform, handle }) => ({
    platform,
    $or: [
      { username: { $regex: new RegExp(`^${handle}$`, 'i') } },
      { name: { $regex: new RegExp(`^${handle}$`, 'i') } },
    ],
  }));

  const accountQuery = {
    $or: [
      { campaignId: campaign._id },
      { _id: { $in: campaign.accountIds || [] } },
      ...(orConditions.length > 0 ? orConditions : []),
    ]
  };

  const scopedAccounts = await SocialAccount.find(accountQuery)
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
      last30DaysPostedViews: [],
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
  const thirtyDaysAgo = startOfDay(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const last30DaysPostedViewsMap = new Map(
    Array.from({ length: 30 }, (_, index) => {
      const date = startOfDay(thirtyDaysAgo);
      date.setDate(date.getDate() + index);
      const key = dateKey(date);
      return [key, {
        dateStr: key,
        views: 0,
        posts: 0,
      }];
    })
  );

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
      last7DaysActivity: last7DayActivityTemplate.map((day) => ({
        ...day,
        posts: [],
      })),
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
      last30DaysPostedViews: Array.from(last30DaysPostedViewsMap.values()),
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
    const sinceKey = dateKey(sinceDate);
    const publishedAt = post.publishedAt ? new Date(post.publishedAt) : null;
    const current = Number((post[latestField] ?? snapshots[snapshots.length - 1]?.[field]) || 0);

    if (snapshots.length === 0) {
      return publishedAt && publishedAt >= sinceDate
        ? current
        : 0;
    }

    const baselineSnapshot = snapshots
      .slice()
      .reverse()
      .find((snapshot) => snapshot.dateStr < sinceKey);
    const firstSnapshotInPeriod = snapshots.find((snapshot) => snapshot.dateStr >= sinceKey);
    const baseline = Number((baselineSnapshot ?? firstSnapshotInPeriod)?.[field] || 0);

    if (!firstSnapshotInPeriod) {
      return publishedAt && publishedAt >= sinceDate
        ? current
        : 0;
    }

    return Math.max(0, current - baseline);
  };

  const periodDeltaBetween = (post, startDate, endDate, field, latestField) => {
    const snapshots = insightMap.get(toKey(post._id)) || [];
    const startKey = dateKey(startDate);
    const endKey = dateKey(endDate);
    const publishedAt = post.publishedAt ? new Date(post.publishedAt) : null;

    if (snapshots.length === 0) {
      return publishedAt && publishedAt >= startDate && publishedAt < endDate
        ? Number(post[latestField] || 0)
        : 0;
    }

    const currentSnapshot = snapshots.find((snapshot) => snapshot.dateStr >= endKey)
      ?? snapshots.find((snapshot) => snapshot.dateStr >= startKey);
    if (!currentSnapshot) {
      return publishedAt && publishedAt >= startDate && publishedAt < endDate
        ? Number(post[latestField] || 0)
        : 0;
    }

    const baselineSnapshot = snapshots
      .slice()
      .reverse()
      .find((snapshot) => snapshot.dateStr < startKey);
    const baseline = Number(baselineSnapshot?.[field] || 0);
    const current = Number(currentSnapshot[field] || 0);

    return Math.max(0, current - baseline);
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
    const latestLikes = Number(post.latestLikes || 0);
    const latestComments = Number(post.latestComments || 0);
    const publishedDateStr = post.publishedAt ? dateKey(post.publishedAt) : '';
    const todayPosts = isPublishedSince(post, todayStart) ? 1 : 0;
    const yesterdayPosts = isPublishedBetween(post, yesterdayStart, todayStart) ? 1 : 0;
    const last7DaysPosts = isPublishedSince(post, sevenDaysAgo) ? 1 : 0;
    const thisMonthPosts = isPublishedSince(post, monthStart) ? 1 : 0;
    const last30DaysPublished = post.publishedAt && new Date(post.publishedAt) >= thirtyDaysAgo;
    const todayViews = todayPosts ? lifetimeViews : 0;
    const yesterdayViews = yesterdayPosts ? lifetimeViews : 0;
    const last7DaysViews = last7DaysPosts ? lifetimeViews : 0;
    const thisMonthViews = thisMonthPosts ? lifetimeViews : 0;
    const todayLikes = todayPosts ? latestLikes : 0;
    const todayComments = todayPosts ? latestComments : 0;
    const yesterdayLikes = yesterdayPosts ? latestLikes : 0;
    const yesterdayComments = yesterdayPosts ? latestComments : 0;
    const last7DaysLikes = last7DaysPosts ? latestLikes : 0;
    const last7DaysComments = last7DaysPosts ? latestComments : 0;
    const thisMonthLikes = thisMonthPosts ? latestLikes : 0;
    const thisMonthComments = thisMonthPosts ? latestComments : 0;

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

    if (last30DaysPublished) {
      const chartDay = last30DaysPostedViewsMap.get(publishedDateStr);
      if (chartDay) {
        chartDay.views += lifetimeViews;
        chartDay.posts += 1;
      }
    }

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
    last30DaysPostedViews: Array.from(last30DaysPostedViewsMap.values()),
    accountRows: Array.from(accountRowsMap.values()),
  };
};

const enrichChannels = async (channels = []) => {
  if (channels.length === 0) return [];

  const lookups = channels.map((ch) => ({
    platform: ch.platform,
    handle: ch.handle?.replace(/^@/, '').toLowerCase(),
  }));

  const orConditions = lookups.map(({ platform, handle }) => ({
    platform,
    $or: [
      { username: { $regex: new RegExp(`^@?${handle}$`, 'i') } },
      { name: { $regex: new RegExp(`^@?${handle}$`, 'i') } },
    ],
  }));

  const matchedAccounts = orConditions.length > 0
    ? await SocialAccount.find({ $or: orConditions })
        .select('_id platform username name isConnected avatarUrl')
        .lean()
    : [];

  return channels.map((ch) => {
    const normalizedHandle = ch.handle?.replace(/^@/, '').toLowerCase();
    const matched = matchedAccounts.find((acc) =>
      acc.platform === ch.platform &&
      (((acc.username || '').replace(/^@/, '').toLowerCase() === normalizedHandle) ||
       ((acc.name || '').replace(/^@/, '').toLowerCase() === normalizedHandle))
    );

    return {
      _id: ch._id,
      platform: ch.platform,
      handle: ch.handle,
      displayName: ch.displayName || '',
      socialAccountId: matched?._id || ch.socialAccountId || null,
      assignedHandlerEmail: ch.assignedHandlerEmail || '',
      assignedHandlerUserId: ch.assignedHandlerUserId || null,
      isVerified: matched ? matched.isConnected !== false : false,
      avatarUrl: matched?.avatarUrl || null,
      addedAt: ch.addedAt,
    };
  });
};

const serializeCampaign = async (campaign) => {
  const campaignObject = campaign.toObject ? campaign.toObject() : campaign;
  const channels = await resolveCampaignPublishingChannels(campaign, { persist: true });
  return {
    ...campaignObject,
    channels,
    metrics: await getCampaignMetrics(campaignObject),
  };
};

const serializeCampaignDetail = async (campaign) => {
  const campaignObject = campaign.toObject ? campaign.toObject() : campaign;
  const channels = await resolveCampaignPublishingChannels(campaign, { persist: false });
  return {
    ...campaignObject,
    channels,
  };
};

const serializeCampaignListItem = (campaign) => {
  const campaignObject = campaign.toObject ? campaign.toObject() : campaign;
  return {
    _id: campaignObject._id,
    name: campaignObject.name || '',
    status: campaignObject.status || 'active',
    mainEmail: campaignObject.mainEmail || '',
    createdBy: campaignObject.createdBy || null,
    updatedAt: campaignObject.updatedAt,
  };
};

const syncCampaignAccounts = async (req, campaignId, accountIds = []) => {
  const uniqueAccountIds = [...new Set(accountIds.map(toKey).filter(Boolean))];
  const validAccounts = await SocialAccount.find(await getAssignableAccountQuery(req, uniqueAccountIds)).select('_id');
  const validAccountIds = validAccounts.map((account) => account._id);

  await Campaign.updateMany(
    { _id: { $ne: campaignId }, accountIds: { $in: validAccountIds } },
    { $pull: { accountIds: { $in: validAccountIds } } }
  );

  await SocialAccount.updateMany(
    { campaignId, _id: { $nin: validAccountIds } },
    { $unset: { campaignId: '' } }
  );

  if (validAccountIds.length > 0) {
    await SocialAccount.updateMany(
      { _id: { $in: validAccountIds } },
      { $set: { campaignId } }
    );
  }

  await Campaign.findByIdAndUpdate(campaignId, { accountIds: validAccountIds });
  return validAccountIds;
};

// @desc    List all users with admin metrics
// @route   GET /api/admin/users
// @access  Private (Owner, Admin)
router.get('/users', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const campaignId = req.query.campaignId;
    if (!campaignId) {
      return res.status(400).json({ message: 'Campaign is required to view team access.' });
    }

    const campaign = await findAccessibleCampaign(req, campaignId);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    const campaignObject = campaign.toObject ? campaign.toObject() : campaign;
    const campaignUserIds = new Set();
    const campaignOwnerUserIds = new Set();
    if (campaignObject.createdBy) campaignUserIds.add(toKey(campaignObject.createdBy));
    if (campaignObject.createdBy) campaignOwnerUserIds.add(toKey(campaignObject.createdBy));

    const campaignMainEmail = normalizeEmail(campaignObject.mainEmail || '');
    if (campaignMainEmail) {
      const mainEmailUser = await User.findOne({ email: campaignMainEmail }).select('_id').lean();
      if (mainEmailUser?._id) campaignUserIds.add(toKey(mainEmailUser._id));
      if (mainEmailUser?._id) campaignOwnerUserIds.add(toKey(mainEmailUser._id));
    }

    const channelSocialAccountIds = await CampaignChannel.find({
      campaignId: campaignObject._id,
      socialAccountId: { $ne: null },
    }).distinct('socialAccountId');

    const campaignMatch = { campaignId: campaignObject._id };
    const accountMatch = {
      $or: [
        { campaignId: campaignObject._id },
        { _id: { $in: campaignObject.accountIds || [] } },
        { _id: { $in: channelSocialAccountIds } },
      ],
    };

    const [
      accountPlatformRows,
      scheduledRows,
      publishedCounts,
      mediaRows,
    ] = await Promise.all([
      SocialAccount.aggregate([
        { $match: accountMatch },
        {
          $group: {
            _id: '$userId',
            accounts: { $sum: 1 },
            connectedAccounts: {
              $sum: { $cond: [{ $eq: ['$isConnected', true] }, 1, 0] },
            },
            platforms: { $addToSet: '$platform' },
            tokenExpiresAt: { $min: '$tokenExpiresAt' },
            tokenStatuses: { $addToSet: '$tokenStatus' },
            tokenRefreshErrors: { $addToSet: '$tokenRefreshError' },
          },
        },
      ]),
      ScheduledPost.aggregate([
        { $match: campaignMatch },
        { $group: { _id: { userId: '$userId', status: '$status' }, count: { $sum: 1 } } },
      ]),
      PublishedPost.aggregate([
        { $match: campaignMatch },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ]),
      Media.aggregate([
        { $match: campaignMatch },
        {
          $group: {
            _id: '$userId',
            count: { $sum: 1 },
            storageBytes: { $sum: { $ifNull: ['$size', 0] } },
          },
        },
      ]),
    ]);

    const scheduledStatusMap = buildStatusMap(scheduledRows);
    const publishedCountMap = buildCountMap(publishedCounts);

    const platformMap = new Map();
    accountPlatformRows.forEach((row) => {
      const userId = toKey(row._id);
      if (!userId) return;
      campaignUserIds.add(userId);
      platformMap.set(userId, {
        accounts: row.accounts || 0,
        connectedAccounts: row.connectedAccounts || 0,
        platforms: row.platforms || [],
        tokenExpiresAt: row.tokenExpiresAt || null,
        tokenStatuses: row.tokenStatuses || [],
        tokenRefreshErrors: (row.tokenRefreshErrors || []).filter(Boolean),
      });
    });

    scheduledRows.forEach((row) => {
      const userId = toKey(row._id?.userId);
      if (userId) campaignUserIds.add(userId);
    });
    publishedCounts.forEach((row) => {
      const userId = toKey(row._id);
      if (userId) campaignUserIds.add(userId);
    });

    const mediaMap = new Map();
    mediaRows.forEach((row) => {
      const userId = toKey(row._id);
      if (!userId) return;
      campaignUserIds.add(userId);
      mediaMap.set(userId, {
        count: row.count || 0,
        storageBytes: row.storageBytes || 0,
      });
    });

    const scopedUserIds = [...campaignUserIds].filter(Boolean);
    if (scopedUserIds.length === 0) {
      return res.status(200).json([]);
    }

    const users = await User.find({ _id: { $in: scopedUserIds } })
      .select('name email avatar role userType createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const payload = users.map((user) => {
      const userId = toKey(user._id);
      const scheduled = scheduledStatusMap.get(userId) || {};
      const media = mediaMap.get(userId) || { count: 0, storageBytes: 0 };
      const accountHealth = platformMap.get(userId) || {
        accounts: 0,
        connectedAccounts: 0,
        platforms: [],
        tokenExpiresAt: null,
        tokenStatuses: [],
        tokenRefreshErrors: [],
      };

      return {
        ...user,
        campaignRole: campaignOwnerUserIds.has(userId) ? 'owner' : 'account_handler',
        metrics: {
          accounts: accountHealth.accounts || 0,
          connectedAccounts: accountHealth.connectedAccounts || 0,
          scheduledPosts: scheduled.scheduled || 0,
          publishingPosts: scheduled.publishing || 0,
          publishedScheduledPosts: scheduled.published || 0,
          failedPosts: scheduled.failed || 0,
          publishedPosts: publishedCountMap.get(userId) || 0,
          media: media.count,
          storageBytes: media.storageBytes,
        },
        accountHealth: {
          platforms: accountHealth.platforms || [],
          tokenExpiresAt: accountHealth.tokenExpiresAt || null,
          tokenStatuses: accountHealth.tokenStatuses || [],
          tokenRefreshErrors: accountHealth.tokenRefreshErrors || [],
        },
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

    const mediaQuery = { folderId: req.params.id };
    if (req.query.campaignId) mediaQuery.campaignId = req.query.campaignId;
    const mediaItems = await Media.find(mediaQuery).select('storageKey thumbnailStorageKey');
    for (const mediaItem of mediaItems) {
      await deleteFile(mediaItem.storageKey);
      if (mediaItem.thumbnailStorageKey) {
        await deleteFile(mediaItem.thumbnailStorageKey);
      }
    }

    await Folder.deleteOne(folderQuery);
    await Media.deleteMany(mediaQuery);

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

    let accountQuery = {};
    const forceWorkspaceScope = req.query.scope === 'workspace';
    if (req.user?.role !== 'owner' || forceWorkspaceScope) {
      const visibleCampaignIds = await Campaign.find(getCampaignAccessQuery(req, { forceWorkspaceScope })).distinct('_id');
      accountQuery = {
        $or: [
          { userId: req.user._id },
          { campaignId: { $in: visibleCampaignIds } },
          { campaignId: { $exists: false } },
          { campaignId: null },
        ],
      };
    }

    const accounts = await SocialAccount.find(accountQuery)
      .populate('userId', 'name email')
      .populate('campaignId', 'name status')
      .sort({ platform: 1, name: 1 })
      .lean();

    res.status(200).json(accounts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    List campaigns without metric/detail payloads
// @route   GET /api/admin/campaigns/list
// @access  Private (Owner, Admin)
router.get('/campaigns/list', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const campaigns = await Campaign.find(getCampaignAccessQuery(req, { forceWorkspaceScope: req.query.scope === 'workspace' }))
      .select('name status mainEmail createdBy updatedAt')
      .populate('createdBy', 'name email')
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json(campaigns.map(serializeCampaignListItem));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/campaigns/:id/metrics', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const campaign = await findAccessibleCampaign(req, req.params.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    const campaignObject = campaign.toObject ? campaign.toObject() : campaign;
    const metrics = await getCampaignMetrics(campaignObject);

    res.status(200).json({
      _id: campaignObject._id,
      metrics,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/campaigns/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const campaign = await findAccessibleCampaign(req, req.params.id)
      .populate({
        path: 'accountIds',
        select: 'name username platform avatarUrl isConnected tokenExpiresAt userId',
        populate: { path: 'userId', select: 'name email' },
      })
      .populate('createdBy', 'name email');

    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    res.status(200).json(await serializeCampaignDetail(campaign));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/campaigns', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    if (!getDBStatus()) {
      return res.status(503).json({ message: 'Database disconnected. Admin panel is unavailable.' });
    }

    const campaigns = await Campaign.find(getCampaignAccessQuery(req, { forceWorkspaceScope: req.query.scope === 'workspace' }))
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
      channels = [],
    } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ message: 'Campaign name is required.' });
    }

    const cleanChannels = channels
      .filter((ch) => ch.platform && ch.handle?.trim())
      .map((ch) => ({
        platform: ch.platform,
        handle: ch.handle.trim(),
        displayName: ch.displayName?.trim() || '',
        assignedHandlerEmail: ch.assignedHandlerEmail?.trim?.().toLowerCase?.() || '',
      }));

    const campaign = await Campaign.create({
      name: name.trim(),
      description,
      productName,
      productWebsite,
      targetAudience,
      primaryGoal,
      mainEmail: mainEmail.trim().toLowerCase(),
      status,
      accountIds: [],
      channels: [],
      createdBy: req.user._id,
    });

    await syncCampaignAccounts(req, campaign._id, accountIds);
    await syncCampaignChannelList(campaign._id, cleanChannels, { userId: req.user._id });

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

    const campaign = await findAccessibleCampaign(req, req.params.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    const { name, description, productName, productWebsite, targetAudience, primaryGoal, mainEmail, status, accountIds, channels } = req.body;

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

    await campaign.save();

    if (Array.isArray(accountIds)) {
      await syncCampaignAccounts(req, campaign._id, accountIds);
    }

    if (Array.isArray(channels)) {
      await syncCampaignChannelList(campaign._id, channels, { userId: req.user._id });
    }

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

    await SocialAccount.updateMany({ campaignId: campaign._id }, { $unset: { campaignId: '' } });
    await Campaign.deleteOne({ _id: campaign._id });
    await CampaignChannel.deleteMany({ campaignId: campaign._id });
    res.status(200).json({ message: 'Campaign deleted successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
