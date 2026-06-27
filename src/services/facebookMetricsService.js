const API_VERSION = 'v20.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;

const toNumber = (value) => Number(value) || 0;

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
  if (!videoId) return 0;

  const metricCandidates = [
    'blue_reels_play_count',
    'post_video_views',
    'total_video_views',
  ];

  let zeroMetric = '';
  for (const metric of metricCandidates) {
    let data;
    try {
      data = await fetchGraphJson(`${videoId}/video_insights`, accessToken, { metric });
    } catch (error) {
      console.warn(`Facebook video insight "${metric}" failed for video ${videoId}:`, error.message);
      continue;
    }

    const entry = data?.data?.find(item => item.name === metric) || data?.data?.[0];
    if (!entry) {
      continue;
    }

    const views = toNumber(getInsightValue({ data: [entry] }));
    if (views > 0) {
      return { views, metric };
    }

    zeroMetric = zeroMetric || metric;
  }

  return { views: 0, metric: zeroMetric || 'video_insights' };
};

export const fetchFacebookPostInsightValue = async (accessToken, postId, metric) => {
  const data = await fetchGraphJson(`${postId}/insights`, accessToken, { metric });
  return getInsightValue(data);
};

export const fetchFacebookPostViews = async (accessToken, post) => {
  const postId = typeof post === 'string' ? post : post?.id || post?.metaPostId;
  let zeroVideoResult = null;

  try {
    const postVideoViews = toNumber(await fetchFacebookPostInsightValue(accessToken, postId, 'post_video_views'));
    if (postVideoViews > 0) {
      return { views: postVideoViews, source: 'post_video_views', videoId: '' };
    }
    zeroVideoResult = { views: 0, source: 'post_video_views', videoId: '' };
  } catch (error) {
    console.warn(`Facebook post video views failed for post ${postId}:`, error.message);
  }

  const videoCandidates = [
    typeof post === 'object' ? post.facebookVideoId : '',
    typeof post === 'object' ? post.object_id : '',
    typeof post === 'object' ? getFacebookReelIdFromPermalink(post.permalink_url || post.permalink) : '',
    typeof post === 'object' ? getFacebookAttachmentVideoId(post) : '',
    getFacebookPostIdCandidate(postId),
    postId,
  ].filter(Boolean);

  const uniqueVideoCandidates = [...new Set(videoCandidates)];
  for (const videoId of uniqueVideoCandidates) {
    try {
      const videoResult = await fetchFacebookVideoViews(accessToken, videoId);
      if (videoResult.views > 0) {
        return { views: videoResult.views, source: videoResult.metric, videoId };
      }
      zeroVideoResult = zeroVideoResult || { views: 0, source: videoResult.metric, videoId };
    } catch (error) {
      console.warn(`Facebook video views failed for video ${videoId}:`, error.message);
    }
  }

  try {
    const views = await fetchFacebookPostInsightValue(accessToken, postId, 'post_impressions_unique');
    return { views: toNumber(views), source: 'post_impressions_unique', videoId: uniqueVideoCandidates[0] || '' };
  } catch (error) {
    console.warn(`Facebook post views fallback failed for post ${postId}:`, error.message);
    return zeroVideoResult || { views: 0, source: 'unavailable', videoId: uniqueVideoCandidates[0] || '' };
  }
};
