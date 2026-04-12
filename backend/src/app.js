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
  app.use(
    compression({
      filter(req, res) {
        if (req.path.startsWith('/api/download/progress/') && req.path.endsWith('/stream')) {
          return false;
        }

        return compression.filter(req, res);
      }
    })
  );
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
        progress: 0,
        label: 'Preparing download',
        error: null,
        speedText: null,
        etaText: null,
        filePath: null,
        fileName: null,
        contentType: null,
        fileSize: null,
        downloadUrl: null,
        cleanupTimer: null,
        abortController: new AbortController(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sseClients: new Set() // Store SSE clients for this job
      };

      preparationJobs.set(jobId, job);

      void (async () => {
        try {
          const preparedDownload = await prepareDownload(normalizedUrl, requestedFormat);
          const trackedJob = preparationJobs.get(jobId);

          if (!trackedJob) {
            return;
          }

          const downloadJob = await createDownloadJob(normalizedUrl, requestedFormat, preparedDownload, {
            signal: trackedJob.abortController.signal,
            onProgress: (progressInfo) => {
              const activeJob = preparationJobs.get(jobId);

              if (!activeJob || activeJob.status !== 'preparing') {
                return;
              }

              console.log(`[Progress] ${progressInfo.percent}% - Speed: ${progressInfo.speedText} - ETA: ${progressInfo.etaText} - Clients: ${activeJob.sseClients.size}`);

              activeJob.progress = progressInfo.percent;
              activeJob.label = 'Downloading';
              activeJob.speedText = progressInfo.speedText;
              activeJob.etaText = progressInfo.etaText;
              activeJob.updatedAt = Date.now();

              // Broadcast progress to all SSE clients
              const progressEvent = JSON.stringify({
                progress: progressInfo.percent,
                speedText: progressInfo.speedText,
                etaText: progressInfo.etaText
              });

              if (activeJob.sseClients.size > 0) {
                activeJob.sseClients.forEach((client) => {
                  client.write(`data: ${progressEvent}\n\n`);
                });
              }
            }
          });

          markPreparationReady(jobId, {
            downloadUrl: `/api/download/file/${jobId}`,
            filePath: downloadJob.filePath,
            fileName: downloadJob.fileName,
            contentType: downloadJob.contentType,
            fileSize: downloadJob.fileSize
          });

          // Notify SSE clients that download is ready
          const finishedJob = preparationJobs.get(jobId);
          if (finishedJob) {
            const readyEvent = JSON.stringify({
              status: 'ready',
              downloadUrl: finishedJob.downloadUrl,
              fileName: finishedJob.fileName
            });
            const clients = Array.from(finishedJob.sseClients);
            clients.forEach((client) => {
              client.write(`data: ${readyEvent}\n\n`);
              client.end();
              finishedJob.sseClients.delete(client);
            });
          }
        } catch (error) {
          markPreparationFailed(jobId, error);

          // Notify SSE clients of failure
          const failedJob = preparationJobs.get(jobId);
          if (failedJob) {
            const errorEvent = JSON.stringify({ status: 'failed', error: error.message });
            const clients = Array.from(failedJob.sseClients);
            clients.forEach((client) => {
              client.write(`data: ${errorEvent}\n\n`);
              client.end();
              failedJob.sseClients.delete(client);
            });
          }
        }
      })();

      res.status(202).json({
        jobId
      });
    })
  );

  app.delete(
    '/api/download/cancel/:jobId',
    (req, res) => {
      const job = preparationJobs.get(req.params.jobId);

      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      if (job.abortController) {
        job.abortController.abort();
      }

      job.status = 'failed';
      job.error = 'Cancelled by user';
      
      const errorEvent = JSON.stringify({ status: 'failed', error: 'Cancelled by user' });
      job.sseClients.forEach((client) => {
        client.write(`data: ${errorEvent}\n\n`);
        client.end();
      });
      job.sseClients.clear();

      void removePreparationJob(job.id);
      res.json({ success: true });
    }
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
    '/api/download/progress/:jobId/stream',
    (req, res) => {
      try {
        const job = preparationJobs.get(req.params.jobId);

        if (!job) {
          res.status(404).json({ error: 'Download preparation job was not found or expired.' });
          return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        // If the job already finished before the client connected, send final state immediately
        if (job.status === 'ready') {
          res.write(`data: ${JSON.stringify({
            status: 'ready',
            downloadUrl: job.downloadUrl,
            fileName: job.fileName
          })}\n\n`);
          res.end();
          return;
        }

        if (job.status === 'failed') {
          res.write(`data: ${JSON.stringify({ status: 'failed', error: job.error })}\n\n`);
          res.end();
          return;
        }

        // Send current progress as initial state
        res.write(`data: ${JSON.stringify({
          progress: job.progress,
          speedText: job.speedText,
          etaText: job.etaText
        })}\n\n`);

        // Register client for live updates
        job.sseClients.add(res);

        const cleanup = () => {
          job.sseClients.delete(res);
          if (!res.writableEnded) res.end();
        };

        req.on('close', cleanup);
        req.on('error', cleanup);
      } catch (error) {
        console.error('SSE stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        } else {
          res.end();
        }
      }
    }
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
