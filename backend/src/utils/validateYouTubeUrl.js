import { createHttpError } from './httpError.js';

const supportedHosts = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
]);

const extractVideoId = (url) => {
  const hostname = url.hostname.toLowerCase();

  if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
    return url.pathname.split('/').filter(Boolean)[0];
  }

  if (url.pathname === '/watch') {
    return url.searchParams.get('v');
  }

  const pathSegments = url.pathname.split('/').filter(Boolean);
  const embeddedIndex = ['shorts', 'embed', 'live'].includes(pathSegments[0]) ? 1 : -1;

  return embeddedIndex === 1 ? pathSegments[1] : null;
};

export const ensureValidYouTubeUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw createHttpError(400, 'Please paste a YouTube video URL first.');
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw createHttpError(400, 'That does not look like a valid URL.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw createHttpError(400, 'Only HTTP or HTTPS YouTube URLs are allowed.');
  }

  if (!supportedHosts.has(parsedUrl.hostname.toLowerCase())) {
    throw createHttpError(400, 'Only YouTube links are supported.');
  }

  const videoId = extractVideoId(parsedUrl);

  if (!videoId || !/^[\w-]{6,}$/.test(videoId)) {
    throw createHttpError(400, 'Please use a direct YouTube video link.');
  }

  return `https://www.youtube.com/watch?v=${videoId}`;
};

