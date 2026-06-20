import path from 'path';

const sanitizeSegment = (value, fallback = 'root') => (
  String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback
);

export const getOriginalStorageKey = ({ userId, folderId, mediaId, originalName }) => {
  const extension = path.extname(originalName || '').toLowerCase() || '.bin';
  return [
    'users',
    sanitizeSegment(userId),
    'folders',
    sanitizeSegment(folderId),
    'media',
    sanitizeSegment(mediaId),
    `original${extension}`,
  ].join('/');
};

export const getThumbnailStorageKey = ({ userId, folderId, mediaId }) => (
  [
    'users',
    sanitizeSegment(userId),
    'folders',
    sanitizeSegment(folderId),
    'media',
    sanitizeSegment(mediaId),
    'thumbnail.jpg',
  ].join('/')
);

export const isStructuredMediaKey = (storageKey) => (
  /^users\/[^/]+\/folders\/[^/]+\/media\/[^/]+\/original\.[^/]+$/i.test(String(storageKey || ''))
);
