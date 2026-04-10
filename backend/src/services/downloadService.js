import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getRawVideoInfo, normalizeRawVideoInfo } from './videoService.js';
import { getFfmpegPath, runYtDlp } from './ytdlpService.js';
import { createHttpError } from '../utils/httpError.js';
import { sanitizeFilename } from '../utils/sanitizeFilename.js';

const findGeneratedFile = async (jobPrefix) => {
  const files = await fs.readdir(config.tempDir);
  const matchedFileName = files.find((fileName) => fileName.startsWith(jobPrefix));

  if (!matchedFileName) {
    throw createHttpError(500, 'Download finished but the generated file could not be located.');
  }

  return path.join(config.tempDir, matchedFileName);
};

const buildVideoSelector = (height) =>
  `bv*[height<=${height}]+ba/b[height<=${height}]/best`;

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

const buildDownloadArgs = ({ youtubeUrl, formatId, jobPrefix }) => {
  const ffmpegDirectory = path.dirname(getFfmpegPath());
  const outputTemplate = path.join(config.tempDir, `${jobPrefix}.%(ext)s`);

  if (formatId === 'audio-mp3') {
    const { contentType, expectedExtension } = getFormatResponseInfo(formatId);

    return {
      expectedExtension,
      contentType,
      args: [
        youtubeUrl,
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
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
      youtubeUrl,
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
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

export const createDownloadJob = async (youtubeUrl, formatId, preparedDownload) => {
  const downloadPlan = preparedDownload || (await prepareDownload(youtubeUrl, formatId));
  const jobPrefix = randomUUID();
  const { args, contentType, expectedExtension } = buildDownloadArgs({
    youtubeUrl,
    formatId,
    jobPrefix
  });

  // yt-dlp downloads to a temp folder and the file is removed as soon as streaming ends.
  await runYtDlp(args);

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
