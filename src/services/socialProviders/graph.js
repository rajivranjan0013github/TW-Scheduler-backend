import { META_GRAPH_API_VERSION } from '../../config/platforms.js';

const getGraphError = (data, fallback) => (
  data?.error?.message ? `${data.error.message}${data.error.code ? ` (code ${data.error.code})` : ''}` : fallback
);

export const createGraphClient = (host, label) => async (path, { method = 'GET', accessToken, body } = {}) => {
  const response = await fetch(`https://${host}/${META_GRAPH_API_VERSION}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const error = new Error(getGraphError(data, `${label} request failed with status ${response.status}`));
    error.data = data;
    throw error;
  }
  return data;
};
