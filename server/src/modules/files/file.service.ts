/**
 * File cleanup service and jobs
 */

import path from 'path';
import fs from 'fs-extra';
import config from '../../config/env';

/**
 * Clean up files older than the specified age limit
 */
export async function cleanupOldFiles(): Promise<number> {
  const uploadDir = path.resolve(config.uploadDir);
  let deletedCount = 0;

  try {
    const files = await fs.readdir(uploadDir);
    const now = Date.now();

    for (const file of files) {
      // Skip special files
      if (file === '.keep' || file === '.gitkeep') continue;

      const filePath = path.join(uploadDir, file);
      
      try {
        const stats = await fs.stat(filePath);
        const age = now - stats.birthtime.getTime();

        if (age > config.fileAgeLimitMs) {
          await fs.remove(filePath);
          deletedCount++;
          console.log(`[Cleanup] Deleted old file: ${file} (age: ${Math.round(age / 1000)}s)`);
        }
      } catch (err) {
        // File might have been deleted already, ignore
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error scanning directory:', err);
  }

  return deletedCount;
}

/**
 * Clean up ALL files in the upload directory
 */
export async function cleanupAllFiles(): Promise<number> {
  const uploadDir = path.resolve(config.uploadDir);
  let deletedCount = 0;

  try {
    const files = await fs.readdir(uploadDir);

    for (const file of files) {
      if (file === '.keep' || file === '.gitkeep') continue;
      
      await fs.remove(path.join(uploadDir, file));
      deletedCount++;
    }

    console.log(`[Cleanup] Deleted ${deletedCount} files`);
  } catch (err) {
    console.error('[Cleanup] Error during cleanup:', err);
  }

  return deletedCount;
}

/**
 * Start the periodic cleanup task
 */
export function startCleanupJob(): NodeJS.Timeout {
  console.log(`[Cleanup] Starting periodic cleanup (every ${config.cleanupIntervalMs / 1000}s)`);
  console.log(`[Cleanup] Files older than ${config.fileAgeLimitMs / 1000}s will be deleted`);

  return setInterval(async () => {
    const deleted = await cleanupOldFiles();
    if (deleted > 0) {
      console.log(`[Cleanup] Periodic cleanup: deleted ${deleted} files`);
    }
  }, config.cleanupIntervalMs);
}

/**
 * Ensure upload directory exists
 */
export async function ensureUploadDir(): Promise<void> {
  const uploadDir = path.resolve(config.uploadDir);
  await fs.ensureDir(uploadDir);
  console.log(`[Files] Upload directory: ${uploadDir}`);
}
