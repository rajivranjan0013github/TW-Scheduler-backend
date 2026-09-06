const normalizeVersion = (value, fallback) => {
  const normalized = String(value || fallback).trim();
  return normalized.startsWith('v') ? normalized : `v${normalized}`;
};

export const META_GRAPH_API_VERSION = normalizeVersion(
  process.env.META_GRAPH_API_VERSION,
  'v26.0',
);
