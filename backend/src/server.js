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

app.listen(config.port, '0.0.0.0', () => {
  console.log(`TubeVault API listening on port ${config.port}`);
});
