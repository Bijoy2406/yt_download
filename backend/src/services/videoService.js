import { config } from '../config.js';
import { getYtDlpAuthArgs, runYtDlp } from './ytdlpService.js';
import { formatBytes, formatDuration } from '../utils/formatters.js';
import { createHttpError } from '../utils/httpError.js';
import { sanitizeFilename } from '../utils/sanitizeFilename.js';

const YOUTUBE_EXTRACTOR_ARGS = ['--extractor-args', 'youtube:player_client=android,web,ios'];

// Additional fallback strategies for production environments
const YOUTUBE_EXTRACTOR_ARGS_FALLBACK_1 = ['--extractor-args', 'youtube:player_client=tv,mweb,web_embedded'];
const YOUTUBE_EXTRACTOR_ARGS_FALLBACK_2 = ['--extractor-args', 'youtube:player_client=web_safari,web_creator'];

const hasPlayableVideoFormats = (rawVideoInfo) =>
  (rawVideoInfo.formats || []).some((format) => format.vcodec !== 'none' && inferHeightFromFormat(format) && !format.has_drm);

const scoreVideoCandidate = (format) =>
  (format.height || 0) * 1000 + (format.fps || 0) * 10 + (format.tbr || 0);

const inferHeightFromFormat = (format) => {
  if (Number.isFinite(format.height) && format.height > 0) {
    return Number(format.height);
  }

  const fromResolution = /x(\d{3,4})/.exec(String(format.resolution || ''));
  if (fromResolution) {
    return Number(fromResolution[1]);
  }

  const fromLabel = /(\d{3,4})p/.exec(
    `${String(format.format_note || '')} ${String(format.format || '')} ${String(format.format_id || '')}`
  );
  if (fromLabel) {
    return Number(fromLabel[1]);
  }

  return null;
};

const buildVideoFormats = (rawVideoInfo) => {
  const videoMap = new Map();

  for (const format of rawVideoInfo.formats || []) {
    const inferredHeight = inferHeightFromFormat(format);

    if (format.vcodec === 'none' || !inferredHeight || format.has_drm) {
      continue;
    }

    if (String(format.format_note || '').toLowerCase().includes('storyboard')) {
      continue;
    }

    const existing = videoMap.get(inferredHeight);
    const nextCandidate = {
      height: inferredHeight,
      fps: format.fps || null,
      filesize: format.filesize || format.filesize_approx || null,
      score: scoreVideoCandidate({ ...format, height: inferredHeight })
    };

    if (!existing || nextCandidate.score > existing.score) {
      videoMap.set(inferredHeight, nextCandidate);
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
  const baseArgs = [
    youtubeUrl,
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--skip-download',
    '--ignore-no-formats-error'
  ];

  const authArgs = getYtDlpAuthArgs();

  // First attempt: default extractor
  const stdout = await runYtDlp([...baseArgs, ...authArgs]);
  const rawVideoInfo = JSON.parse(stdout);

  if (hasPlayableVideoFormats(rawVideoInfo)) {
    return rawVideoInfo;
  }

  console.log('First attempt failed to get video formats, trying fallback player clients...');

  // Second attempt: android,web,ios clients
  const fallback1Stdout = await runYtDlp([
    ...baseArgs,
    ...YOUTUBE_EXTRACTOR_ARGS,
    ...authArgs
  ]);
  const fallback1Info = JSON.parse(fallback1Stdout);

  if (hasPlayableVideoFormats(fallback1Info)) {
    console.log('Fallback 1 (android,web,ios) succeeded');
    return fallback1Info;
  }

  console.log('Fallback 1 failed, trying fallback 2 (tv,mweb,web_embedded)...');

  // Third attempt: tv,mweb,web_embedded clients
  const fallback2Stdout = await runYtDlp([
    ...baseArgs,
    ...YOUTUBE_EXTRACTOR_ARGS_FALLBACK_1,
    ...authArgs
  ]);
  const fallback2Info = JSON.parse(fallback2Stdout);

  if (hasPlayableVideoFormats(fallback2Info)) {
    console.log('Fallback 2 (tv,mweb,web_embedded) succeeded');
    return fallback2Info;
  }

  console.log('Fallback 2 failed, trying fallback 3 (web_safari,web_creator)...');

  // Fourth attempt: web_safari,web_creator clients
  const fallback3Stdout = await runYtDlp([
    ...baseArgs,
    ...YOUTUBE_EXTRACTOR_ARGS_FALLBACK_2,
    ...authArgs
  ]);

  console.log('Returning result from final fallback attempt');
  return JSON.parse(fallback3Stdout);
};

export const getVideoInfo = async (youtubeUrl) => {
  const rawVideoInfo = await getRawVideoInfo(youtubeUrl);
  return normalizeRawVideoInfo(rawVideoInfo);
};
