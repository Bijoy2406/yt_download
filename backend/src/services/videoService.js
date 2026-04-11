import { config } from '../config.js';
import { getYtDlpAuthArgs, runYtDlp } from './ytdlpService.js';
import { formatBytes, formatDuration } from '../utils/formatters.js';
import { createHttpError } from '../utils/httpError.js';
import { sanitizeFilename } from '../utils/sanitizeFilename.js';

const scoreVideoCandidate = (format) =>
  (format.height || 0) * 1000 + (format.fps || 0) * 10 + (format.tbr || 0);

const buildVideoFormats = (rawVideoInfo) => {
  const videoMap = new Map();

  for (const format of rawVideoInfo.formats || []) {
    if (format.vcodec === 'none' || !format.height || format.has_drm) {
      continue;
    }

    if (String(format.format_note || '').toLowerCase().includes('storyboard')) {
      continue;
    }

    const existing = videoMap.get(format.height);
    const nextCandidate = {
      height: format.height,
      fps: format.fps || null,
      filesize: format.filesize || format.filesize_approx || null,
      score: scoreVideoCandidate(format)
    };

    if (!existing || nextCandidate.score > existing.score) {
      videoMap.set(format.height, nextCandidate);
    }
  }

  return [...videoMap.values()]
    .sort((left, right) => right.height - left.height)
    .slice(0, 8)
    .map((item) => ({
      id: `video-${item.height}`,
      type: 'video',
      extension: 'mp4',
      resolution: `${item.height}p`,
      label: `${item.height}p MP4`,
      detail: item.filesize ? `Approx. ${formatBytes(item.filesize)}` : 'Best available quality',
      badge: item.fps && item.fps >= 50 ? `${item.fps} fps` : 'Video + audio'
    }));
};

const buildAudioFormats = (rawVideoInfo) => {
  const bestAudio = [...(rawVideoInfo.formats || [])]
    .filter((format) => format.acodec !== 'none')
    .sort((left, right) => (right.abr || 0) - (left.abr || 0))[0];

  return [
    {
      id: 'audio-mp3',
      type: 'audio',
      extension: 'mp3',
      resolution: 'Audio only',
      label: 'MP3',
      detail: bestAudio?.abr ? `Up to ${Math.round(bestAudio.abr)} kbps source audio` : 'Best available source audio',
      badge: 'Quick download'
    }
  ];
};

export const normalizeRawVideoInfo = (rawVideoInfo) => {
  if (!rawVideoInfo || !rawVideoInfo.title) {
    throw createHttpError(404, 'The video could not be fetched. It may be private or unavailable.');
  }

  if (rawVideoInfo.duration && rawVideoInfo.duration > config.maxVideoDurationSeconds) {
    throw createHttpError(
      413,
      `Videos longer than ${Math.floor(config.maxVideoDurationSeconds / 3600)} hours are not allowed.`
    );
  }

  const formats = [
    ...buildVideoFormats(rawVideoInfo),
    ...buildAudioFormats(rawVideoInfo)
  ];

  if (!formats.length) {
    throw createHttpError(404, 'No supported download formats were available for this video.');
  }

  const thumbnail =
    rawVideoInfo.thumbnail ||
    [...(rawVideoInfo.thumbnails || [])].sort(
      (left, right) => (right.preference || right.width || 0) - (left.preference || left.width || 0)
    )[0]?.url ||
    null;

  return {
    title: rawVideoInfo.title,
    safeTitle: sanitizeFilename(rawVideoInfo.title),
    thumbnail,
    durationSeconds: rawVideoInfo.duration || 0,
    durationLabel: formatDuration(rawVideoInfo.duration || 0),
    uploader: rawVideoInfo.uploader || rawVideoInfo.channel || 'YouTube',
    formats,
    quickActions: {
      audioOnlyFormatId: 'audio-mp3'
    }
  };
};

export const getRawVideoInfo = async (youtubeUrl) => {
  const stdout = await runYtDlp([
    youtubeUrl,
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--skip-download',
    '--ignore-no-formats-error',
    ...getYtDlpAuthArgs()
  ]);

  return JSON.parse(stdout);
};

export const getVideoInfo = async (youtubeUrl) => {
  const rawVideoInfo = await getRawVideoInfo(youtubeUrl);
  return normalizeRawVideoInfo(rawVideoInfo);
};
