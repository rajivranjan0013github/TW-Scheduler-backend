import SocialAccount from '../models/SocialAccount.js';
import CampaignChannel from '../models/CampaignChannel.js';
import Campaign from '../models/Campaign.js';
import PublishedPost from '../models/PublishedPost.js';

const DEFAULT_TIMEZONE = 'UTC';
const DAY_MS = 24 * 60 * 60 * 1000;

const normalizeTimeZone = (timeZone) => {
  if (!timeZone || typeof timeZone !== 'string') return DEFAULT_TIMEZONE;
  try {
    Intl.DateTimeFormat(undefined, { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

const getZonedParts = (date, timeZone = DEFAULT_TIMEZONE) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  return parts.reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
};

const getTimezoneOffsetMs = (date, timeZone = DEFAULT_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - new Date(date).getTime();
};

const startOfDay = (date, timeZone = DEFAULT_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);
  const utcGuess = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const offsetMs = getTimezoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
};

const dateKey = (date, timeZone = DEFAULT_TIMEZONE) => {
  const { year, month, day } = getZonedParts(date, timeZone);
  return `${year}-${month}-${day}`;
};

const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

const startOfMonth = (date, timeZone = DEFAULT_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);
  const utcGuess = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, 1));
  const offsetMs = getTimezoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
};

export const getCreatorAnalytics = async ({ user, campaignId = '', timeZone: rawTimeZone = DEFAULT_TIMEZONE }) => {
  const timeZone = normalizeTimeZone(rawTimeZone);
  const userId = user._id;
  const userEmail = (user.email || '').toLowerCase().trim();

  // 1. Find all social accounts owned directly by the user
  const directAccounts = await SocialAccount.find({ userId }).lean();

  // 2. Find all campaign channels assigned to this user (by userId, email, or linked account)
  const directAccountIds = directAccounts.map((acc) => acc._id);
  const channelConditions = [
    { assignedHandlerUserId: userId },
    ...(userEmail ? [{ assignedHandlerEmail: userEmail }] : []),
    ...(directAccountIds.length > 0 ? [{ socialAccountId: { $in: directAccountIds } }] : []),
  ];

  if (campaignId && campaignId !== 'all') {
    channelConditions.forEach((cond) => {
      cond.campaignId = campaignId;
    });
  }

  const assignedChannels = await CampaignChannel.find({ $or: channelConditions }).lean();

  // Extract linked social account IDs from assigned channels
  const assignedSocialAccountIds = assignedChannels
    .map((chan) => chan.socialAccountId)
    .filter(Boolean)
    .map((id) => String(id));

  // Also collect campaign IDs for the campaign selector
  const allCreatorChannels = await CampaignChannel.find({
    $or: [
      { assignedHandlerUserId: userId },
      ...(userEmail ? [{ assignedHandlerEmail: userEmail }] : []),
      ...(directAccountIds.length > 0 ? [{ socialAccountId: { $in: directAccountIds } }] : []),
    ],
  }).lean();

  const campaignIds = [...new Set(allCreatorChannels.map((chan) => String(chan.campaignId)).filter(Boolean))];
  const campaigns = await Campaign.find({ _id: { $in: campaignIds }, status: { $ne: 'archived' } })
    .select('_id name')
    .lean();

  // 3. Fetch any additional social accounts linked via CampaignChannel
  const additionalAccounts = assignedSocialAccountIds.length > 0
    ? await SocialAccount.find({ _id: { $in: assignedSocialAccountIds } }).lean()
    : [];

  // Combine and deduplicate social accounts
  const accountMap = new Map();
  directAccounts.forEach((acc) => accountMap.set(String(acc._id), acc));
  additionalAccounts.forEach((acc) => accountMap.set(String(acc._id), acc));

  const scopedAccounts = Array.from(accountMap.values());
  const accountIds = scopedAccounts.map((acc) => acc._id);

  const emptyResult = {
    campaigns,
    selectedCampaignId: campaignId || 'all',
    metrics: {
      accounts: 0,
      posts: 0,
      todayPosts: 0,
      yesterdayPosts: 0,
      last7DaysPosts: 0,
      thisMonthPosts: 0,
      lifetimeViews: 0,
      todayViews: 0,
      yesterdayViews: 0,
      last7DaysViews: 0,
      thisMonthViews: 0,
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
    },
  };

  if (accountIds.length === 0) {
    return emptyResult;
  }

  // 4. Date ranges
  const now = new Date();
  const todayStart = startOfDay(now, timeZone);
  const yesterdayStart = addDays(todayStart, -1);
  const last7DaysStart = addDays(todayStart, -6);
  const last30DaysStart = addDays(todayStart, -29);
  const monthStart = startOfMonth(now, timeZone);

  const last30DaysPostedViewsMap = new Map(
    Array.from({ length: 30 }, (_, index) => {
      const date = addDays(last30DaysStart, index);
      const key = dateKey(date, timeZone);
      return [key, {
        dateStr: key,
        views: 0,
        posts: 0,
      }];
    })
  );

  // 5. Query PublishedPost
  const postQuery = {
    accountId: { $in: accountIds },
    ...(campaignId && campaignId !== 'all' ? { campaignId } : {}),
  };

  const posts = await PublishedPost.find(postQuery)
    .select('_id accountId campaignId platform publishedAt latestViews latestLikes latestComments')
    .lean();

  // 6. Build channel/account rows
  const accountRowsMap = new Map(
    scopedAccounts.map((acc) => [
      String(acc._id),
      {
        _id: acc._id,
        name: acc.name || 'Unknown Channel',
        username: acc.username || '',
        platform: acc.platform || '',
        avatarUrl: acc.avatarUrl || '',
        isConnected: Boolean(acc.isConnected),
        posts: 0,
        todayPosts: 0,
        yesterdayPosts: 0,
        last7DaysPosts: 0,
        thisMonthPosts: 0,
        lifetimeViews: 0,
        todayViews: 0,
        yesterdayViews: 0,
        last7DaysViews: 0,
        thisMonthViews: 0,
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
      },
    ])
  );

  let lifetimeViews = 0;
  let todayViews = 0;
  let yesterdayViews = 0;
  let last7DaysViews = 0;
  let thisMonthViews = 0;

  let todayPosts = 0;
  let yesterdayPosts = 0;
  let last7DaysPosts = 0;
  let thisMonthPosts = 0;

  let latestLikes = 0;
  let latestComments = 0;
  let todayLikes = 0;
  let todayComments = 0;
  let yesterdayLikes = 0;
  let yesterdayComments = 0;
  let last7DaysLikes = 0;
  let last7DaysComments = 0;
  let thisMonthLikes = 0;
  let thisMonthComments = 0;

  posts.forEach((post) => {
    const views = Number(post.latestViews || 0);
    const likes = Number(post.latestLikes || 0);
    const comments = Number(post.latestComments || 0);
    const publishedAt = post.publishedAt ? new Date(post.publishedAt) : null;
    const postAccount = accountRowsMap.get(String(post.accountId));

    lifetimeViews += views;
    latestLikes += likes;
    latestComments += comments;

    if (postAccount) {
      postAccount.posts += 1;
      postAccount.lifetimeViews += views;
      postAccount.latestLikes += likes;
      postAccount.latestComments += comments;
    }

    if (!publishedAt || Number.isNaN(publishedAt.getTime())) {
      return;
    }

    const postDateKey = dateKey(publishedAt, timeZone);
    const dayBucket = last30DaysPostedViewsMap.get(postDateKey);
    if (dayBucket) {
      dayBucket.views += views;
      dayBucket.posts += 1;
    }

    const isToday = publishedAt >= todayStart;
    const isYesterday = publishedAt >= yesterdayStart && publishedAt < todayStart;
    const isLast7Days = publishedAt >= last7DaysStart;
    const isThisMonth = publishedAt >= monthStart;

    if (isToday) {
      todayPosts += 1;
      todayViews += views;
      todayLikes += likes;
      todayComments += comments;
      if (postAccount) {
        postAccount.todayPosts += 1;
        postAccount.todayViews += views;
        postAccount.todayLikes += likes;
        postAccount.todayComments += comments;
      }
    } else if (isYesterday) {
      yesterdayPosts += 1;
      yesterdayViews += views;
      yesterdayLikes += likes;
      yesterdayComments += comments;
      if (postAccount) {
        postAccount.yesterdayPosts += 1;
        postAccount.yesterdayViews += views;
        postAccount.yesterdayLikes += likes;
        postAccount.yesterdayComments += comments;
      }
    }

    if (isLast7Days) {
      last7DaysPosts += 1;
      last7DaysViews += views;
      last7DaysLikes += likes;
      last7DaysComments += comments;
      if (postAccount) {
        postAccount.last7DaysPosts += 1;
        postAccount.last7DaysViews += views;
        postAccount.last7DaysLikes += likes;
        postAccount.last7DaysComments += comments;
      }
    }

    if (isThisMonth) {
      thisMonthPosts += 1;
      thisMonthViews += views;
      thisMonthLikes += likes;
      thisMonthComments += comments;
      if (postAccount) {
        postAccount.thisMonthPosts += 1;
        postAccount.thisMonthViews += views;
        postAccount.thisMonthLikes += likes;
        postAccount.thisMonthComments += comments;
      }
    }
  });

  const accountRows = Array.from(accountRowsMap.values()).sort(
    (a, b) => b.lifetimeViews - a.lifetimeViews
  );

  return {
    campaigns,
    selectedCampaignId: campaignId || 'all',
    metrics: {
      accounts: accountRows.length,
      posts: posts.length,
      todayPosts,
      yesterdayPosts,
      last7DaysPosts,
      thisMonthPosts,
      lifetimeViews,
      todayViews,
      yesterdayViews,
      last7DaysViews,
      thisMonthViews,
      latestLikes,
      latestComments,
      todayLikes,
      todayComments,
      yesterdayLikes,
      yesterdayComments,
      last7DaysLikes,
      last7DaysComments,
      thisMonthLikes,
      thisMonthComments,
      last30DaysPostedViews: Array.from(last30DaysPostedViewsMap.values()),
      accountRows,
    },
  };
};
