import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getRawVideoInfo, normalizeRawVideoInfo } from './videoService.js';
import { getFfmpegPath, getYtDlpAuthArgs, runYtDlp } from './ytdlpService.js';
import { createHttpError } from '../utils/httpError.js';
import { sanitizeFilename } from '../utils/sanitizeFilename.js';

const YOUTUBE_EXTRACTOR_ARGS = ['--extractor-args', 'youtube:player_client=android,web,ios'];
const YOUTUBE_EXTRACTOR_ARGS_FALLBACK_1 = ['--extractor-args', 'youtube:player_client=tv,mweb,web_embedded'];
const YOUTUBE_EXTRACTOR_ARGS_FALLBACK_2 = ['--extractor-args', 'youtube:player_client=web_safari,web_creator'];

const isFormatUnavailableError = (error) =>
  /Requested format is not available/i.test(String(error?.message || ''));

const findGeneratedFile = async (jobPrefix) => {
  const files = await fs.readdir(config.tempDir);
  const matchedFileName = files.find((fileName) => fileName.startsWith(jobPrefix));

  if (!matchedFileName) {
    throw createHttpError(500, 'Download finished but the generated file could not be located.');
  }

  return path.join(config.tempDir, matchedFileName);
};

const buildVideoSelector = (height) =>
  // Multiple fallback selectors to handle different YouTube format availability
  // Try to get video+audio, fallback to single stream, then best available
  `bv*[height=${height}]+ba/bv*[height<=${height}]+ba/b[height<=${height}]/bv[height<=${height}]+ba/best[height<=${height}]/best`;

const parsePercentFromYtDlpLine = (line) => {
  const match = /(\d{1,3}(?:\.\d+)?)%/.exec(line);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);

  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, value));
};

const parseSpeedFromYtDlpLine = (line) => {
  const match = /\bat\s+([^\s]+\/s)\b/i.exec(line);

  if (!match) {
    return null;
  }

  return match[1];
};

const parseEtaFromYtDlpLine = (line) => {
  const match = /\bETA\s+([0-9:]+|Unknown)\b/i.exec(line);

  if (!match) {
    return null;
  }

  return match[1];
};

const getFormatResponseInfo = (formatId) => {
  if (formatId === 'audio-mp3') {
    return {
      expectedExtension: 'mp3',
      contentType: 'audio/mpeg'
    };
  }

  const match = /^video-(\d{3,4})$/.exec(formatId);

  if (!match) {
    throw createHttpError(400, 'The requested format is not supported.');
  }

  return {
    expectedExtension: 'mp4',
    contentType: 'video/mp4',
    height: Number(match[1])
  };
};

const buildDownloadArgs = ({
  youtubeUrl,
  formatId,
  jobPrefix,
  enableProgress,
  extractorArgs,
  audioFormatSelector
}) => {
  const ffmpegDirectory = path.dirname(getFfmpegPath());
  const outputTemplate = path.join(config.tempDir, `${jobPrefix}.%(ext)s`);
  const baseArgs = [
    youtubeUrl,
    '--no-playlist',
    '--no-warnings',
    ...(extractorArgs ? extractorArgs : []),
    ...getYtDlpAuthArgs()
  ];

  if (enableProgress) {
    baseArgs.push('--newline');
  } else {
    baseArgs.push('--no-progress');
  }

  if (formatId === 'audio-mp3') {
    const { contentType, expectedExtension } = getFormatResponseInfo(formatId);

    return {
      expectedExtension,
      contentType,
      args: [
        ...baseArgs,
        ...(audioFormatSelector ? ['-f', audioFormatSelector] : []),
        '--extract-audio',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '--ffmpeg-location',
        ffmpegDirectory,
        '--output',
        outputTemplate
      ]
    };
  }

  const { contentType, expectedExtension, height } = getFormatResponseInfo(formatId);

  return {
    expectedExtension,
    contentType,
    args: [
      ...baseArgs,
      '-f',
      buildVideoSelector(height),
      '--recode-video',
      'mp4',
      '--merge-output-format',
      'mp4',
      '--ffmpeg-location',
      ffmpegDirectory,
      '--output',
      outputTemplate
    ]
  };
};

export const prepareDownload = async (youtubeUrl, formatId) => {
  const rawVideoInfo = await getRawVideoInfo(youtubeUrl);
  const videoInfo = normalizeRawVideoInfo(rawVideoInfo);
  const supportedFormatIds = new Set(videoInfo.formats.map((format) => format.id));

  if (!supportedFormatIds.has(formatId)) {
    throw createHttpError(400, 'The requested format was not offered for this video.');
  }

  if (rawVideoInfo.age_limit && rawVideoInfo.age_limit >= 18) {
    throw createHttpError(403, 'Age-restricted videos are not supported by this downloader.');
  }

  const { contentType, expectedExtension } = getFormatResponseInfo(formatId);
  const safeTitle = sanitizeFilename(videoInfo.title);
  const fileName =
    formatId === 'audio-mp3'
      ? `${safeTitle}.mp3`
      : `${safeTitle}-${formatId.replace('video-', '')}p.mp4`;

  return {
    contentType,
    expectedExtension,
    fileName
  };
};

export const createDownloadJob = async (youtubeUrl, formatId, preparedDownload, options = {}) => {
  const { onProgress } = options;
  const downloadPlan = preparedDownload || (await prepareDownload(youtubeUrl, formatId));
  const jobPrefix = randomUUID();
  
  // Enhanced retry strategies with different player clients for production environments
  const attemptStrategies =
    formatId === 'audio-mp3'
      ? [
          { extractorArgs: null, audioFormatSelector: 'bestaudio/best' },
          { extractorArgs: YOUTUBE_EXTRACTOR_ARGS, audioFormatSelector: 'bestaudio/best' },
          { extractorArgs: YOUTUBE_EXTRACTOR_ARGS_FALLBACK_1, audioFormatSelector: 'bestaudio/best' },
          { extractorArgs: YOUTUBE_EXTRACTOR_ARGS_FALLBACK_2, audioFormatSelector: 'bestaudio/best' },
          { extractorArgs: null, audioFormatSelector: null },
          { extractorArgs: YOUTUBE_EXTRACTOR_ARGS, audioFormatSelector: null }
        ]
      : [
          { extractorArgs: null },
          { extractorArgs: YOUTUBE_EXTRACTOR_ARGS },
          { extractorArgs: YOUTUBE_EXTRACTOR_ARGS_FALLBACK_1 },
          { extractorArgs: YOUTUBE_EXTRACTOR_ARGS_FALLBACK_2 }
        ];

  let runArgs = null;
  let contentType = downloadPlan.contentType;
  let expectedExtension = downloadPlan.expectedExtension;

  let stderrBuffer = '';
  let lastProgress = 0;
  let lastSpeedText = null;
  let lastEtaText = null;

  // yt-dlp downloads to a temp folder and the file is removed as soon as streaming ends.
  let lastError;
  for (let index = 0; index < attemptStrategies.length; index += 1) {
    const strategy = attemptStrategies[index];
    const built = buildDownloadArgs({
      youtubeUrl,
      formatId,
      jobPrefix,
      enableProgress: typeof onProgress === 'function',
      extractorArgs: strategy.extractorArgs,
      audioFormatSelector: strategy.audioFormatSelector
    });

    runArgs = built.args;
    contentType = built.contentType;
    expectedExtension = built.expectedExtension;

    try {
      const strategyLabel = strategy.extractorArgs 
        ? strategy.extractorArgs[1] 
        : 'default';
      console.log(`Download attempt ${index + 1} using: ${strategyLabel}`);

      await runYtDlp(runArgs, {
        onStderrData: typeof onProgress === 'function'
          ? (chunk) => {
              stderrBuffer += chunk;
              const lines = stderrBuffer.split(/\r?\n/);
              stderrBuffer = lines.pop() || '';

              for (const line of lines) {
                const parsed = parsePercentFromYtDlpLine(line);
                const speedText = parseSpeedFromYtDlpLine(line);
                const etaText = parseEtaFromYtDlpLine(line);

                if (speedText) {
                  lastSpeedText = speedText;
                }

                if (etaText) {
                  lastEtaText = etaText;
                }

                if (parsed === null || parsed < lastProgress) {
                  continue;
                }

                lastProgress = parsed;
                onProgress({
                  percent: parsed,
                  speedText: lastSpeedText,
                  etaText: lastEtaText
                });
              }
            }
          : undefined
      });

      console.log(`Download succeeded on attempt ${index + 1}`);
      break;
    } catch (error) {
      lastError = error;
      console.error(`Download attempt ${index + 1} failed:`, error.message);

      if (!isFormatUnavailableError(error) || index === attemptStrategies.length - 1) {
        throw error;
      }

      console.log(`Retrying with different player client...`);
    }
  }

  if (lastError && runArgs === null) {
    throw lastError;
  }

  let filePath = path.join(config.tempDir, `${jobPrefix}.${expectedExtension}`);

  try {
    await fs.access(filePath);
  } catch {
    filePath = await findGeneratedFile(jobPrefix);
  }

  const stat = await fs.stat(filePath);

  return {
    fileName: downloadPlan.fileName,
    filePath,
    fileSize: stat.size,
    contentType: contentType || downloadPlan.contentType
  };
};

export const resolveDirectVideoDownloadUrl = async (youtubeUrl, formatId) => {
  if (!formatId.startsWith('video-')) {
    return null;
  }

  const { height } = getFormatResponseInfo(formatId);
  const progressiveSelector = `b[height<=${height}][ext=mp4]/b[height<=${height}]/best[height<=${height}]`;

  // Try multiple player clients for direct URL resolution
  const extractorStrategies = [
    [],
    YOUTUBE_EXTRACTOR_ARGS,
    YOUTUBE_EXTRACTOR_ARGS_FALLBACK_1,
    YOUTUBE_EXTRACTOR_ARGS_FALLBACK_2
  ];

  for (const extractorArgs of extractorStrategies) {
    try {
      const stdout = await runYtDlp([
        youtubeUrl,
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        ...(extractorArgs.length > 0 ? extractorArgs : []),
        '-f',
        progressiveSelector,
        '-g',
        ...getYtDlpAuthArgs()
      ]);

      const directUrl = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

      if (directUrl) {
        return directUrl;
      }
    } catch (error) {
      console.log(`Direct URL resolution failed with extractor: ${extractorArgs[1] || 'default'}`);
      // Continue to next strategy
    }
  }

  return null;
};
