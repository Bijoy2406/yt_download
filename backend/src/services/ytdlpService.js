import ffmpegPath from 'ffmpeg-static';
import { spawn, execSync } from 'node:child_process';
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

/**
 * Aggressively kill a child process and its tree (especially important on Windows)
 */
const killProcessTree = async (pid, label = '') => {
  if (!pid) return;

  const logLabel = label ? `[${label}]` : '';

  if (process.platform === 'win32') {
    // On Windows, try multiple methods to ensure process dies
    console.error(`${logLabel} Killing Windows process tree ${pid}...`);
    
    // Method 1: Try taskkill with /T (tree) and /F (force)
    try {
      console.error(`${logLabel} Attempt 1: taskkill /PID ${pid} /T /F`);
      execSync(`taskkill /PID ${pid} /T /F`, {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000
      });
      console.error(`${logLabel} Success: taskkill killed process tree ${pid}`);
      return;
    } catch (error) {
      console.error(`${logLabel} taskkill /T failed: ${error.message}`);
    }
    
    // Method 2: Try taskkill without /T
    try {
      console.error(`${logLabel} Attempt 2: taskkill /PID ${pid} /F`);
      execSync(`taskkill /PID ${pid} /F`, {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000
      });
      console.error(`${logLabel} Success: taskkill killed process ${pid}`);
      return;
    } catch (error) {
      console.error(`${logLabel} taskkill /F failed: ${error.message}`);
    }

    // Method 3: Try wmic (works on older Windows)
    try {
      console.error(`${logLabel} Attempt 3: wmic process call terminate --where "ProcessId=${pid}"`);
      execSync(`wmic process call terminate --where "ProcessId=${pid}"`, {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000
      });
      console.error(`${logLabel} Success: wmic terminated process ${pid}`);
      return;
    } catch (error) {
      console.error(`${logLabel} wmic failed: ${error.message}`);
    }
  } else {
    // On Unix-like systems, try multiple signals
    console.error(`${logLabel} Killing Unix process group -${pid}...`);
    
    // Method 1: Try SIGKILL on process group
    try {
      console.error(`${logLabel} Attempt 1: kill -KILL -${pid}`);
      process.kill(-pid, 'SIGKILL');
      console.error(`${logLabel} Success: SIGKILL sent to process group -${pid}`);
      return;
    } catch (error) {
      console.error(`${logLabel} SIGKILL to group failed: ${error.message}`);
    }

    // Method 2: Try SIGTERM on process group
    try {
      console.error(`${logLabel} Attempt 2: kill -TERM -${pid}`);
      process.kill(-pid, 'SIGTERM');
      console.error(`${logLabel} SIGTERM sent to process group -${pid}`);
      return;
    } catch (error) {
      console.error(`${logLabel} SIGTERM to group failed: ${error.message}`);
    }

    // Method 3: Try SIGKILL on direct pid
    try {
      console.error(`${logLabel} Attempt 3: kill -KILL ${pid}`);
      process.kill(pid, 'SIGKILL');
      console.error(`${logLabel} Success: SIGKILL sent to process ${pid}`);
      return;
    } catch (error) {
      console.error(`${logLabel} SIGKILL to pid failed: ${error.message}`);
    }
  }

  console.error(`${logLabel} All kill attempts failed for PID ${pid}`);
};

export const runYtDlp = async (args, options = {}) => {
  const { onStdoutData, onStderrData, signal } = options;
  await ensureRuntimeReady();

  const normalizedArgs = ['--ignore-config', ...args];
  const cookiesFlagIndex = normalizedArgs.findIndex((arg) => arg === '--cookies');

  if (cookiesFlagIndex !== -1 && normalizedArgs[cookiesFlagIndex + 1] && resolvedCookiesFilePath) {
    normalizedArgs[cookiesFlagIndex + 1] = resolvedCookiesFilePath;
  }

  return new Promise((resolve, reject) => {
    let child;
    let isAborted = false;
    let isFinished = false;

    try {
      child = spawn(resolvedYtDlpPath, normalizedArgs, {
        windowsHide: true,
        // Create a new process group on Unix so we can send signals to the group
        detached: process.platform !== 'win32'
      });
    } catch (error) {
      reject(createHttpError(502, `yt-dlp could not start: ${error.message}`));
      return;
    }

    const childPid = child.pid;
    console.log(`[yt-dlp] Process started: PID ${childPid}`);

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      if (!isAborted) {
        stdout += chunk;
        onStdoutData?.(chunk);
      }
    });

    child.stderr.on('data', (chunk) => {
      if (!isAborted) {
        stderr = `${stderr}${chunk}`.slice(-4000);
        onStderrData?.(chunk);
      }
    });

    child.on('error', (error) => {
      if (isFinished) return;
      isFinished = true;
      console.error(`[yt-dlp] Process error:`, error.message);
      reject(createHttpError(502, `yt-dlp could not start: ${error.message}`));
    });

    // Setup abort signal handler - this must handle the abort BEFORE the process finishes
    if (signal) {
      if (signal.aborted) {
        // Signal already aborted before we could attach listener
        console.log(`[yt-dlp] Signal already aborted, killing process immediately`);
        isAborted = true;
        // Call async kill without awaiting (fire and forget)
        void killProcessTree(childPid, 'yt-dlp-abort');
        if (isFinished) return;
        isFinished = true;
        reject(new Error('Download cancelled by user'));
        return;
      }

      const abortHandler = () => {
        if (isAborted || isFinished) return;
        isAborted = true;
        isFinished = true;
        
        console.log(`[yt-dlp] Abort signal received, killing process tree ${childPid}`);
        
        // Kill immediately and aggressively (fire and forget)
        void killProcessTree(childPid, 'yt-dlp-abort');
        
        // Also try direct kill just in case
        try {
          child.kill('SIGKILL');
        } catch (e) {
          // Already dead
        }
        
        reject(new Error('Download cancelled by user'));
      };

      signal.addEventListener('abort', abortHandler, { once: true });
    }

    child.on('close', (code) => {
      if (isFinished) return;
      isFinished = true;

      if (isAborted) {
        console.log(`[yt-dlp] Process terminated after abort`);
        reject(new Error('Download cancelled by user'));
        return;
      }

      if (code === 0) {
        console.log(`[yt-dlp] Process completed successfully`);
        resolve(stdout);
        return;
      }

      console.error(`[yt-dlp] Process exited with code ${code}`);
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
