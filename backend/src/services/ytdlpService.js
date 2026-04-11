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
let resolvedCookiesFilePath;

const getManagedBinaryPath = () =>
  path.join(config.binaryDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const getManagedCookiesPath = () => path.join(config.tempDir, 'yt-dlp-cookies.txt');

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

const ensureWritableCookiesFile = async () => {
  if (!config.ytDlpCookiesFile) {
    return null;
  }

  const managedCookiesPath = getManagedCookiesPath();

  try {
    if (path.resolve(config.ytDlpCookiesFile) !== path.resolve(managedCookiesPath)) {
      await fs.copyFile(config.ytDlpCookiesFile, managedCookiesPath);
    }
  } catch (error) {
    throw createHttpError(
      500,
      `YT_DLP_COOKIES_FILE could not be copied to writable storage: ${error.message}`
    );
  }

  return managedCookiesPath;
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
      const cookiesPath = await ensureWritableCookiesFile();
      resolvedYtDlpPath = binaryPath;
      resolvedCookiesFilePath = cookiesPath;

      return {
        ytDlpPath: binaryPath,
        ffmpegPath,
        cookiesPath
      };
    })().catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
  }

  return runtimePromise;
};

export const runYtDlp = async (args, options = {}) => {
  const { onStdoutData, onStderrData } = options;
  await ensureRuntimeReady();

  const normalizedArgs = ['--ignore-config', ...args];
  const cookiesFlagIndex = normalizedArgs.findIndex((arg) => arg === '--cookies');

  if (cookiesFlagIndex !== -1 && normalizedArgs[cookiesFlagIndex + 1] && resolvedCookiesFilePath) {
    normalizedArgs[cookiesFlagIndex + 1] = resolvedCookiesFilePath;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedYtDlpPath, normalizedArgs, {
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      onStdoutData?.(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
      onStderrData?.(chunk);
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
    return ['--cookies', resolvedCookiesFilePath || getManagedCookiesPath()];
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
