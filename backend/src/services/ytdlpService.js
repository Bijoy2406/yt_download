import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { createHttpError } from '../utils/httpError.js';

const ytDlpReleaseAssetByPlatform = {
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp_linux',
  darwin: 'yt-dlp_macos'
};

let runtimePromise;
let resolvedYtDlpPath;

const getManagedBinaryPath = () =>
  path.join(config.binaryDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const resolveYtDlpBinaryPath = () => config.ytDlpPath || getManagedBinaryPath();

const getYtDlpDownloadUrl = () => {
  const assetName = ytDlpReleaseAssetByPlatform[process.platform];

  if (!assetName) {
    throw createHttpError(
      500,
      `Unsupported deployment platform for automatic yt-dlp install: ${process.platform}`
    );
  }

  return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
};

const downloadManagedBinary = async () => {
  const binaryPath = getManagedBinaryPath();
  const downloadUrl = getYtDlpDownloadUrl();
  const partialPath = `${binaryPath}.partial`;

  await fs.mkdir(config.binaryDir, { recursive: true });

  const response = await fetch(downloadUrl, { redirect: 'follow' });

  if (!response.ok || !response.body) {
    throw createHttpError(
      500,
      `Unable to download yt-dlp binary from GitHub (${response.status}).`
    );
  }

  // The binary is cached on disk so cold starts only pay this cost once.
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath));
  await fs.rename(partialPath, binaryPath);

  if (process.platform !== 'win32') {
    await fs.chmod(binaryPath, 0o755);
  }
};

const ensureTempDir = async () => {
  await fs.mkdir(config.tempDir, { recursive: true });
};

const ensureYtDlpBinary = async () => {
  const binaryPath = resolveYtDlpBinaryPath();

  try {
    await fs.access(binaryPath);
  } catch {
    if (config.ytDlpPath) {
      throw createHttpError(
        500,
        `YT_DLP_PATH was provided but no binary was found at ${binaryPath}.`
      );
    }

    await downloadManagedBinary();
  }

  return binaryPath;
};

export const ensureRuntimeReady = async () => {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (!ffmpegPath) {
        throw createHttpError(500, 'ffmpeg-static could not resolve a binary path.');
      }

      await ensureTempDir();
      const binaryPath = await ensureYtDlpBinary();
      resolvedYtDlpPath = binaryPath;

      return {
        ytDlpPath: binaryPath,
        ffmpegPath
      };
    })().catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
  }

  return runtimePromise;
};

export const runYtDlp = async (args) => {
  await ensureRuntimeReady();

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedYtDlpPath, args, {
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });

    child.on('error', (error) => {
      reject(createHttpError(502, `yt-dlp could not start: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        createHttpError(
          502,
          stderr.trim() || `yt-dlp exited with code ${code}.`,
          { exitCode: code }
        )
      );
    });
  });
};

export const getYtDlpAuthArgs = () => {
  if (config.ytDlpCookiesFile) {
    return ['--cookies', config.ytDlpCookiesFile];
  }

  if (config.ytDlpCookiesFromBrowser) {
    return ['--cookies-from-browser', config.ytDlpCookiesFromBrowser];
  }

  return [];
};

export const getFfmpegPath = () => {
  if (!ffmpegPath) {
    throw createHttpError(500, 'ffmpeg binary was not available.');
  }

  return ffmpegPath;
};
