const API_VERSION = 'v20.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;
const FAILURE_LOG_TTL_MS = 15 * 60 * 1000;
const UNSUPPORTED_CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000;

const recentFailureLogs = new Map();
const disabledCapabilities = new Map();

const toNumber = (value) => Number(value) || 0;

const getGraphErrorCode = (error) => Number(error?.error?.code || error?.status || 0);

const warnMetricFailure = (operation, error) => {
  const code = getGraphErrorCode(error);
  const key = `${operation}:${code}:${error?.error?.error_subcode || ''}`;
  const now = Date.now();
  if ((recentFailureLogs.get(key) || 0) > now) return;

  recentFailureLogs.set(key, now + FAILURE_LOG_TTL_MS);
  console.warn(`[Facebook Metrics] ${operation} unavailable`, {
    code: code || undefined,
    message: String(error?.message || error).slice(0, 300),
    suppressedForMinutes: FAILURE_LOG_TTL_MS / 60000,
  });
};

export const isFacebookRateLimit = (error) => {
  const code = getGraphErrorCode(error);
  return code === 429 || [4, 17, 32, 613, 80004].includes(code);
};

const disableUnsupportedCapability = (capability, error) => {
  if (![12, 100].includes(getGraphErrorCode(error))) return;
  disabledCapabilities.set(capability, Date.now() + UNSUPPORTED_CAPABILITY_TTL_MS);
};

const isCapabilityDisabled = (capability) => {
  const disabledUntil = disabledCapabilities.get(capability) || 0;
  if (disabledUntil > Date.now()) return true;
  disabledCapabilities.delete(capability);
  return false;
};

const fetchGraphJson = async (path, accessToken, params = {}) => {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.error?.message || `Facebook Graph request failed (${response.status})`);
    error.status = response.status;
    error.error = data.error;
    throw error;
  }

  return data;
};

const getInsightValue = (responseBody) => (
  responseBody?.data?.[0]?.values?.[0]?.value
  ?? responseBody?.data?.[0]?.total_value?.value
  ?? 0
);

export const getFacebookPostIdCandidate = (postId = '') => {
  const parts = String(postId).split('_').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : '';
};

const getFacebookReelIdFromPermalink = (permalink = '') => {
  const match = String(permalink).match(/\/reel\/(\d+)/);
  return match?.[1] || '';
};

const isFacebookVideoPermalink = (permalink = '') => (
  /\/(?:videos?|watch|share\/v)\//i.test(String(permalink))
  || /facebook\.com\/watch\/?\?v=/i.test(String(permalink))
  || /fb\.watch\//i.test(String(permalink))
);

export const getFacebookAttachmentVideoId = (post = {}) => {
  const attachments = post.attachments?.data || [];
  const queue = [...attachments];

  while (queue.length > 0) {
    const attachment = queue.shift();
    if (!attachment) continue;

    if (attachment.subattachments?.data?.length) {
      queue.push(...attachment.subattachments.data);
    }

    const type = String(attachment.type || '').toLowerCase();
    const targetId = attachment.target?.id;
    if (targetId && (type.includes('video') || type.includes('reel'))) {
      return targetId;
    }
  }

  return '';
};

export const fetchFacebookVideoViews = async (accessToken, videoId) => {
  const capabilityKey = `video_views_field:${videoId}`;
  if (!videoId || isCapabilityDisabled(capabilityKey)) {
    return { views: null, metric: 'unavailable' };
  }

  try {
    // A real Video object exposes its lifetime view count as a field. This avoids
    // the deprecated singular-status /video_insights metrics previously probed.
    const data = await fetchGraphJson(videoId, accessToken, { fields: 'views' });
    if (data?.views === undefined || data?.views === null) {
      return { views: null, metric: 'unavailable' };
    }
    return { views: toNumber(data.views), metric: 'video_views' };
  } catch (error) {
    disableUnsupportedCapability(capabilityKey, error);
    warnMetricFailure('video views', error);
    return { views: null, metric: 'unavailable' };
  }
};

export const fetchFacebookPostInsightValue = async (accessToken, postId, metric) => {
  const data = await fetchGraphJson(`${postId}/insights`, accessToken, { metric });
  return getInsightValue(data);
};

export const fetchFacebookPostEngagement = async (accessToken, postId) => {
  if (!postId) return { likes: null, comments: null, errorType: 'invalid_post' };

  // 1. Primary: Use Post Insights (requires only 'pages_read_engagement')
  try {
    const data = await fetchGraphJson(`${postId}/insights`, accessToken, {
      metric: 'post_reactions_by_type_total,post_activity_by_action_type',
    });
    const items = data?.data || [];
    const reactionsItem = items.find((d) => d.name === 'post_reactions_by_type_total');
    const activityItem = items.find((d) => d.name === 'post_activity_by_action_type');

    if (reactionsItem || activityItem) {
      const reactionsVal = reactionsItem?.values?.[0]?.value || {};
      const activityVal = activityItem?.values?.[0]?.value || {};

      const likes = typeof reactionsVal === 'object' && reactionsVal !== null
        ? Object.values(reactionsVal).reduce((sum, count) => sum + (Number(count) || 0), 0)
        : toNumber(reactionsVal);

      const comments = typeof activityVal === 'object' && activityVal !== null
        ? toNumber(activityVal.comment || activityVal.comments || 0)
        : 0;

      return { likes, comments, errorType: '' };
    }
  } catch (insightsError) {
    // Insights API unavailable for this post type or permission issue, fallback to fields query
    const insightsCode = getGraphErrorCode(insightsError);
    if (insightsCode === 10) {
      warnMetricFailure('post engagement insights', insightsError);
    }
  }

  // 2. Fallback: Direct post fields query (requires 'pages_read_user_content')
  try {
    const data = await fetchGraphJson(postId, accessToken, {
      fields: 'comments.limit(0).summary(true),reactions.type(LIKE).limit(0).summary(total_count)',
    });
    return {
      likes: data?.reactions?.summary?.total_count === undefined
        ? null
        : toNumber(data.reactions.summary.total_count),
      comments: data?.comments?.summary?.total_count === undefined
        ? null
        : toNumber(data.comments.summary.total_count),
      errorType: '',
    };
  } catch (error) {
    const errorType = getGraphErrorCode(error) === 10 ? 'permission_missing' : 'unavailable';
    warnMetricFailure('post engagement', error);
    return { likes: null, comments: null, errorType };
  }
};

export const fetchFacebookPostCommentsCount = async (accessToken, postId) => (
  (await fetchFacebookPostEngagement(accessToken, postId)).comments
);

export const fetchFacebookPostViews = async (accessToken, post) => {
  const postId = typeof post === 'string' ? post : post?.id || post?.metaPostId;

  // Only use IDs supplied by Facebook as video objects. Do not derive a video
  // ID from the post ID or send a combined Page_post ID to /video_insights.
  const videoCandidates = [
    typeof post === 'object' ? post.facebookVideoId : '',
    typeof post === 'object' && String(post.mediaType || '').toLowerCase().includes('video')
      ? post.object_id
      : '',
    typeof post === 'object' && isFacebookVideoPermalink(post.permalink_url || post.permalink)
      ? post.object_id
      : '',
    typeof post === 'object' ? getFacebookReelIdFromPermalink(post.permalink_url || post.permalink) : '',
    typeof post === 'object' ? getFacebookAttachmentVideoId(post) : '',
  ].filter(Boolean);

  const uniqueVideoCandidates = [...new Set(videoCandidates)];
  for (const videoId of uniqueVideoCandidates) {
    const videoResult = await fetchFacebookVideoViews(accessToken, videoId);
    if (videoResult.views !== null) {
      return { views: videoResult.views, source: videoResult.metric, videoId };
    }
  }

  return {
    views: null,
    source: 'unavailable',
    videoId: uniqueVideoCandidates[0] || '',
    postId,
  };
};
