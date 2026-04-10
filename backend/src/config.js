import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');

const normalizeOrigin = (origin) => {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
};

const splitOrigins = (value) =>
  (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .map(normalizeOrigin)
    .filter(Boolean);

export const config = {
  backendRoot,
  port: Number(process.env.PORT || 3000),
  corsOrigins: splitOrigins(process.env.CORS_ORIGIN),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 25),
  maxVideoDurationSeconds: Number(process.env.MAX_VIDEO_DURATION_SECONDS || 4 * 60 * 60),
  tempDir: path.join(backendRoot, 'tmp'),
  binaryDir: path.join(backendRoot, 'bin'),
  ytDlpPath: process.env.YT_DLP_PATH?.trim() || null,
  ytDlpCookiesFile: process.env.YT_DLP_COOKIES_FILE?.trim() || null,
  ytDlpCookiesFromBrowser: process.env.YT_DLP_COOKIES_FROM_BROWSER?.trim() || null
};
