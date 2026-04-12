import { config } from '../config.js';
import { getYtDlpAuthArgs, runYtDlp } from './ytdlpService.js';
import { formatBytes, formatDuration } from '../utils/formatters.js';
import { createHttpError } from '../utils/httpError.js';
import { sanitizeFilename } from '../utils/sanitizeFilename.js';

const EXTRACTOR_ARG_STRATEGIES = [
  null,
  ['--extractor-args', 'youtube:player_client=android,web,ios'],
  ['--extractor-args', 'youtube:player_client=tv,mweb,web_embedded'],
  ['--extractor-args', 'youtube:player_client=web_safari,web_creator']
];

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

  for (let i = 0; i < EXTRACTOR_ARG_STRATEGIES.length; i++) {
    const extractorArgs = EXTRACTOR_ARG_STRATEGIES[i];
    const extraArgs = extractorArgs ?? [];
    const stdout = await runYtDlp([...baseArgs, ...extraArgs, ...authArgs]);
    const rawVideoInfo = JSON.parse(stdout);

    if (hasPlayableVideoFormats(rawVideoInfo) || i === EXTRACTOR_ARG_STRATEGIES.length - 1) {
      if (i > 0) {
        console.log(`getRawVideoInfo succeeded with strategy ${i}: ${extraArgs[1]}`);
      }
      return { rawVideoInfo, winningExtractorArgs: extractorArgs };
    }

    console.log(`getRawVideoInfo strategy ${i} returned no playable formats, trying next...`);
  }
};

export const getVideoInfo = async (youtubeUrl) => {
  const { rawVideoInfo } = await getRawVideoInfo(youtubeUrl);
  return normalizeRawVideoInfo(rawVideoInfo);
};
