const API_VERSION = 'v20.0';

const getGraphHost = (account) => (
  account.authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com'
);

const fetchGraphJson = async (account, path, params = {}) => {
  const url = new URL(`https://${getGraphHost(account)}/${API_VERSION}/${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });
  url.searchParams.set('access_token', account.accessToken);

  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || `Instagram Graph request failed (${response.status})`);
    error.status = response.status;
    error.error = body.error;
    throw error;
  }
  return body;
};

const getInsightValue = (payload, metric) => {
  const entry = payload?.data?.find((item) => item.name === metric);
  const value = entry?.values?.[0]?.value ?? entry?.total_value?.value;
  return value === undefined || value === null ? null : Number(value) || 0;
};

const isAuthenticationError = (error) => (
  Number(error?.error?.code || 0) === 190 || [401, 403].includes(Number(error?.status || 0))
);

export const isRateLimitError = (error) => {
  const code = Number(error?.error?.code || error?.status || 0);
  return code === 429 || [4, 17, 32, 613, 80004].includes(code);
};

export const fetchInstagramMediaMetrics = async (account, mediaId) => {
  const [mediaResult, insightResult] = await Promise.allSettled([
    // Likes and comments are media fields, not media-insight metrics.
    fetchGraphJson(account, mediaId, { fields: 'like_count,comments_count' }),
    fetchGraphJson(account, `${mediaId}/insights`, { metric: 'views' }),
  ]);

  const failures = [mediaResult, insightResult]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  const authenticationError = failures.find(isAuthenticationError);
  if (authenticationError) throw authenticationError;

  const rateLimitError = failures.find(isRateLimitError);
  if (rateLimitError) {
    rateLimitError.status = 429;
    rateLimitError.retryable = true;
    throw rateLimitError;
  }

  const media = mediaResult.status === 'fulfilled' ? mediaResult.value : null;
  const insights = insightResult.status === 'fulfilled' ? insightResult.value : null;
  const likes = media?.like_count === undefined ? null : Number(media.like_count) || 0;
  const comments = media?.comments_count === undefined ? null : Number(media.comments_count) || 0;
  const views = insights ? getInsightValue(insights, 'views') : null;

  return {
    views,
    likes,
    comments,
    viewsSource: views === null ? 'unavailable' : 'instagram_views',
    hasFreshMetrics: views !== null || likes !== null || comments !== null,
    errors: failures.map((error) => ({
      status: Number(error?.status || 0) || undefined,
      code: Number(error?.error?.code || 0) || undefined,
      message: String(error?.message || error).slice(0, 300),
    })),
  };
};
