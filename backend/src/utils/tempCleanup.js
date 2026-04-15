import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Cleans up files in the temp directory that are older than maxAgeMs
 * @param {string} tempDir - The temp directory path
 * @param {number} maxAgeMs - Maximum age of files in milliseconds (default: 24 hours)
 * @returns {Promise<{deleted: number, errors: number}>}
 */
export const cleanupTempDirectory = async (tempDir, maxAgeMs = 24 * 60 * 60 * 1000) => {
  const now = Date.now();
  let deleted = 0;
  let errors = 0;

  try {
    // Ensure the temp directory exists
    try {
      await fs.access(tempDir);
    } catch {
      // Directory doesn't exist, nothing to clean
      return { deleted: 0, errors: 0 };
    }

    const files = await fs.readdir(tempDir);

    for (const filename of files) {
      const filePath = path.join(tempDir, filename);

      try {
        const stats = await fs.stat(filePath);

        // Calculate file age in milliseconds
        const fileAge = now - stats.mtimeMs;

        if (fileAge > maxAgeMs) {
          await fs.unlink(filePath);
          deleted++;
          console.log(`[TempCleanup] Deleted old file: ${filename} (${Math.floor(fileAge / 1000 / 60 / 60)} hours old)`);
        }
      } catch (error) {
        errors++;
        console.error(`[TempCleanup] Error processing file ${filename}:`, error);
      }
    }

    if (deleted > 0 || errors > 0) {
      console.log(`[TempCleanup] Cleanup completed: ${deleted} files deleted, ${errors} errors`);
    }
  } catch (error) {
    console.error('[TempCleanup] Error during temp directory cleanup:', error);
    errors++;
  }

  return { deleted, errors };
};

/**
 * Starts periodic cleanup of the temp directory
 * @param {string} tempDir - The temp directory path
 * @param {number} intervalMs - Interval between cleanups (default: 1 hour)
 * @param {number} maxAgeMs - Maximum age of files in milliseconds (default: 24 hours)
 * @returns {NodeJS.Timeout} - The interval ID (can be used to cancel with clearInterval)
 */
export const startPeriodicCleanup = (tempDir, intervalMs = 60 * 60 * 1000, maxAgeMs = 24 * 60 * 60 * 1000) => {
  console.log(`[TempCleanup] Starting periodic cleanup every ${intervalMs / 1000 / 60} minutes`);
  console.log(`[TempCleanup] Files older than ${maxAgeMs / 1000 / 60 / 60} hours will be deleted`);

  // Run cleanup immediately on startup
  void cleanupTempDirectory(tempDir, maxAgeMs);

  // Then run it periodically
  return setInterval(() => {
    void cleanupTempDirectory(tempDir, maxAgeMs);
  }, intervalMs);
};
