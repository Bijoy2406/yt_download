import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import {
  createDownloadJob,
  prepareDownload,
  resolveDirectVideoDownloadUrl
} from './services/downloadService.js';
import { getVideoInfo } from './services/videoService.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { createHttpError } from './utils/httpError.js';
import { ensureValidYouTubeUrl } from './utils/validateYouTubeUrl.js';

const PREPARATION_JOB_TTL_MS = 15 * 60 * 1000;
const PROGRESS_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PROGRESS_RATE_LIMIT_MAX = 240;

const buildCorsConfig = () => {
  if (!config.corsOrigins.length) {
    return {
      origin: true,
      exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type']
    };
  }

  return {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(createHttpError(403, 'This origin is not allowed to call the API.'));
    },
    exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type']
  };
};

export const createApp = () => {
  const app = express();
  const preparationJobs = new Map();
  const defaultLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/api/download/progress/'),
    message: {
      error: 'Too many requests. Please wait a few minutes before trying again.'
    }
  });
  const progressLimiter = rateLimit({
    windowMs: PROGRESS_RATE_LIMIT_WINDOW_MS,
    limit: PROGRESS_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many progress checks. Please wait a few seconds and try again.'
    }
  });

  const removePreparationJob = async (jobId) => {
    const job = preparationJobs.get(jobId);

    if (!job) {
      return;
    }

    if (job.cleanupTimer) {
      clearTimeout(job.cleanupTimer);
    }

    preparationJobs.delete(jobId);

    if (job.filePath) {
      try {
        await fs.unlink(job.filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Failed to remove expired temp file:', error);
        }
      }
    }
  };

  const markPreparationFailed = (jobId, error) => {
    const job = preparationJobs.get(jobId);

    if (!job) {
      return;
    }

    job.status = 'failed';
    job.error = error.message || 'Download preparation failed.';
    job.label = 'Preparation failed';
    job.progress = Math.min(job.progress, 99);
    job.updatedAt = Date.now();
    job.cleanupTimer = setTimeout(() => {
      void removePreparationJob(jobId);
    }, PREPARATION_JOB_TTL_MS);
  };

  const markPreparationReady = (jobId, payload) => {
    const job = preparationJobs.get(jobId);

    if (!job) {
      return;
    }

    job.status = 'ready';
    job.progress = 100;
    job.label = 'Ready to download';
    job.updatedAt = Date.now();
    job.downloadUrl = payload.downloadUrl;
    job.fileName = payload.fileName || job.fileName || null;
    job.contentType = payload.contentType || job.contentType || null;
    job.fileSize = payload.fileSize || job.fileSize || null;
    job.filePath = payload.filePath || null;
    job.cleanupTimer = setTimeout(() => {
      void removePreparationJob(jobId);
    }, PREPARATION_JOB_TTL_MS);
  };

  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(compression());
  app.use(cors(buildCorsConfig()));
  app.use(defaultLimiter);
  app.use(morgan('combined'));

  app.get('/api/health', (_, res) => {
    res.json({
      status: 'ok',
      service: 'tubevault-api'
    });
  });

  app.get(
    '/api/info',
    asyncHandler(async (req, res) => {
      const normalizedUrl = ensureValidYouTubeUrl(req.query.url);
      const video = await getVideoInfo(normalizedUrl);

      res.json({ video });
    })
  );
  app.get('/', (req, res) => {
    res.status(200).send('Server is awake');
  });

  app.post(
    '/api/download/prepare',
    asyncHandler(async (req, res) => {
      const normalizedUrl = ensureValidYouTubeUrl(req.query.url);
      const requestedFormat = `${req.query.format || ''}`.trim();

      if (!requestedFormat) {
        throw createHttpError(400, 'A format is required before starting the download.');
      }

      const jobId = randomUUID();
      const job = {
        id: jobId,
        status: 'preparing',
        progress: 1,
        label: 'Validating video',
        error: null,
        speedText: null,
        etaText: null,
        filePath: null,
        fileName: null,
        contentType: null,
        fileSize: null,
        downloadUrl: null,
        cleanupTimer: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      preparationJobs.set(jobId, job);

      void (async () => {
        try {
          const preparedDownload = await prepareDownload(normalizedUrl, requestedFormat);
          const trackedJob = preparationJobs.get(jobId);

          if (!trackedJob) {
            return;
          }

          trackedJob.progress = 12;
          trackedJob.label = 'Reading stream metadata';
          trackedJob.updatedAt = Date.now();

          trackedJob.progress = 35;
          trackedJob.label = 'Preparing file on server';
          trackedJob.updatedAt = Date.now();

          const downloadJob = await createDownloadJob(normalizedUrl, requestedFormat, preparedDownload, {
            onProgress: (progressInfo) => {
              const activeJob = preparationJobs.get(jobId);

              if (!activeJob || activeJob.status !== 'preparing') {
                return;
              }

              activeJob.progress = Math.max(
                activeJob.progress,
                Math.min(95, Math.round(35 + progressInfo.percent * 0.6))
              );
              activeJob.label = 'Preparing file on server';
              activeJob.speedText = progressInfo.speedText || activeJob.speedText;
              activeJob.etaText = progressInfo.etaText || activeJob.etaText;
              activeJob.updatedAt = Date.now();
            }
          });

          markPreparationReady(jobId, {
            downloadUrl: `/api/download/file/${jobId}`,
            filePath: downloadJob.filePath,
            fileName: downloadJob.fileName,
            contentType: downloadJob.contentType,
            fileSize: downloadJob.fileSize
          });
        } catch (error) {
          markPreparationFailed(jobId, error);
        }
      })();

      res.status(202).json({
        jobId
      });
    })
  );

  app.get(
    '/api/download/progress/:jobId',
    progressLimiter,
    asyncHandler(async (req, res) => {
      const job = preparationJobs.get(req.params.jobId);

      if (!job) {
        throw createHttpError(404, 'Download preparation job was not found or expired.');
      }

      res.json({
        job: {
          id: job.id,
          status: job.status,
          progress: job.progress,
          label: job.label,
          error: job.error,
          speedText: job.speedText,
          etaText: job.etaText,
          downloadUrl: job.downloadUrl,
          fileName: job.fileName,
          updatedAt: job.updatedAt
        }
      });
    })
  );

  app.get(
    '/api/download/file/:jobId',
    asyncHandler(async (req, res) => {
      const job = preparationJobs.get(req.params.jobId);

      if (!job || job.status !== 'ready' || !job.filePath) {
        throw createHttpError(404, 'Prepared download was not found or has expired.');
      }

      res.setHeader('Content-Type', job.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${job.fileName || 'download.bin'}"`);

      if (job.fileSize) {
        res.setHeader('Content-Length', String(job.fileSize));
      }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');

      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) {
          return;
        }

        cleaned = true;
        await removePreparationJob(job.id);
      };

      const fileStream = createReadStream(job.filePath);
      fileStream.on('error', async (error) => {
        console.error('Prepared download stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed while streaming the file.' });
        } else {
          res.destroy(error);
        }
      });

      res.on('close', cleanup);
      res.on('finish', cleanup);
      fileStream.pipe(res);
    })
  );

  app.get(
    '/api/download',
    asyncHandler(async (req, res) => {
      const normalizedUrl = ensureValidYouTubeUrl(req.query.url);
      const requestedFormat = `${req.query.format || ''}`.trim();

      if (!requestedFormat) {
        throw createHttpError(400, 'A format is required before starting the download.');
      }

      const preparedDownload = await prepareDownload(normalizedUrl, requestedFormat);

      if (requestedFormat.startsWith('video-')) {
        try {
          const directUrl = await resolveDirectVideoDownloadUrl(normalizedUrl, requestedFormat);

          if (directUrl) {
            res.redirect(302, directUrl);
            return;
          }
        } catch (error) {
          console.warn('Direct video URL resolution failed; falling back to server download.', error);
        }
      }

      const downloadJob = await createDownloadJob(normalizedUrl, requestedFormat, preparedDownload);
      res.setHeader('Content-Type', downloadJob.contentType || preparedDownload.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${downloadJob.fileName || preparedDownload.fileName}"`);
      res.setHeader('Content-Length', String(downloadJob.fileSize));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');

      const cleanup = async () => {
        try {
          await fs.unlink(downloadJob.filePath);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.error('Failed to remove temp file:', error);
          }
        }
      };

      const fileStream = createReadStream(downloadJob.filePath);
      fileStream.on('error', async (error) => {
        console.error('Download stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed while streaming the file.' });
        } else {
          res.destroy(error);
        }
      });

      res.on('close', cleanup);
      res.on('finish', cleanup);
      fileStream.pipe(res);
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
