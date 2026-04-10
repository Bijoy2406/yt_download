import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createDownloadJob, prepareDownload } from './services/downloadService.js';
import { getVideoInfo } from './services/videoService.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { createHttpError } from './utils/httpError.js';
import { ensureValidYouTubeUrl } from './utils/validateYouTubeUrl.js';

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

  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(compression());
  app.use(cors(buildCorsConfig()));
  app.use(
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: 'Too many requests. Please wait a few minutes before trying again.'
      }
    })
  );
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
  app.get(
    '/api/download',
    asyncHandler(async (req, res) => {
      const normalizedUrl = ensureValidYouTubeUrl(req.query.url);
      const requestedFormat = `${req.query.format || ''}`.trim();

      if (!requestedFormat) {
        throw createHttpError(400, 'A format is required before starting the download.');
      }

      const preparedDownload = await prepareDownload(normalizedUrl, requestedFormat);
      res.setHeader('Content-Type', preparedDownload.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${preparedDownload.fileName}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const downloadJob = await createDownloadJob(normalizedUrl, requestedFormat, preparedDownload);
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
