import { config } from './config.js';
import { createApp } from './app.js';
import { ensureRuntimeReady } from './services/ytdlpService.js';

const app = createApp();

try {
  await ensureRuntimeReady();
  console.log('yt-dlp runtime ready');
} catch (error) {
  console.error('Runtime warmup failed. The API will retry lazily on the first request.');
  console.error(error);
}

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`TubeVault API listening on port ${config.port}`);
});

// Graceful shutdown handling
const gracefulShutdown = () => {
  console.log('[Server] Shutting down gracefully...');
  
  // Clear cleanup interval
  if (app.cleanupIntervalId) {
    clearInterval(app.cleanupIntervalId);
    console.log('[Server] Cleanup interval cleared');
  }
  
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
