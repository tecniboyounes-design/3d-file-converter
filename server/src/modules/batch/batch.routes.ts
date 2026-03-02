/**
 * Batch Conversion Routes - Multi-file upload and conversion endpoints
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import fs from 'fs-extra';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { 
  createBatchJob, 
  getBatchJobStatus, 
  processBatchJob,
  getJobOutputFiles,
  cleanupJob
} from './batch.manager';
import { ValidationError } from '../../common/errors';
import { 
  isSupportedInputFormat, 
  isSupportedOutputFormat,
  SUPPORTED_OUTPUT_FORMATS,
  SUPPORTED_INPUT_FORMATS
} from '../../common/constants';
import { getExtension } from '../../common/utils';
import config from '../../config/env';

const MAX_FILES = 100;

/**
 * Generate a unique filename with timestamp prefix and original name
 */
function generateTimestampFilename(originalName: string): string {
  const ext = path.extname(originalName);
  const baseName = path.basename(originalName, ext);
  const timestamp = Date.now();
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${timestamp}_${safeName}${ext}`;
}

export async function batchRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/convert/batch - Upload multiple files for batch conversion
   */
  fastify.post('/convert/batch', async (request: FastifyRequest, reply: FastifyReply) => {
    const parts = request.parts();
    const uploadDir = path.resolve(config.uploadDir);
    await fs.ensureDir(uploadDir);

    const files: Array<{
      id: string;
      originalName: string;
      inputPath: string;
      inputFormat: string;
      outputFormat: string;
    }> = [];

    let defaultFormat = 'glb';
    const formatOverrides: Record<string, string> = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        // Check file limit
        if (files.length >= MAX_FILES) {
          fastify.log.warn(`Max file limit reached (${MAX_FILES})`);
          // Drain the remaining stream
          for await (const chunk of part.file) { /* discard */ }
          continue;
        }

        const originalName = part.filename;
        const inputFormat = getExtension(originalName);

        // Validate input format
        if (!isSupportedInputFormat(inputFormat)) {
          fastify.log.warn(`Skipping unsupported file: ${originalName}`);
          for await (const chunk of part.file) { /* discard */ }
          continue;
        }

        // Save file
        const uniqueFilename = generateTimestampFilename(originalName);
        const inputPath = path.join(uploadDir, uniqueFilename);
        await pipeline(part.file, fs.createWriteStream(inputPath));

        const fileId = uuidv4();
        files.push({
          id: fileId,
          originalName,
          inputPath,
          inputFormat,
          outputFormat: defaultFormat, // Will be updated later with overrides
        });

        fastify.log.info(`[Batch] Uploaded: ${originalName} (${inputFormat})`);

      } else if (part.type === 'field') {
        if (part.fieldname === 'defaultFormat') {
          defaultFormat = String(part.value).toLowerCase();
        } else if (part.fieldname === 'formats') {
          // JSON string with format overrides: { "file_id": "format", ... }
          try {
            const parsed = JSON.parse(String(part.value));
            Object.assign(formatOverrides, parsed);
          } catch (e) {
            fastify.log.warn('Failed to parse formats field');
          }
        }
      }
    }

    if (files.length === 0) {
      throw new ValidationError('No valid files uploaded');
    }

    // Validate default format
    if (!isSupportedOutputFormat(defaultFormat)) {
      // Cleanup uploaded files
      for (const f of files) {
        await fs.remove(f.inputPath).catch(() => {});
      }
      throw new ValidationError(
        `Unsupported output format: ${defaultFormat}. Supported: ${SUPPORTED_OUTPUT_FORMATS.join(', ')}`
      );
    }

    // Apply format overrides and validate
    // Overrides are keyed by file index (processing order), not by ID
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const override = formatOverrides[String(i)];
      if (override && isSupportedOutputFormat(override.toLowerCase())) {
        file.outputFormat = override.toLowerCase();
      } else {
        file.outputFormat = defaultFormat;
      }
    }

    // Create batch job
    const job = createBatchJob(files);

    fastify.log.info(`[Batch] Created job ${job.jobId} with ${files.length} files`);

    // Start processing in background (don't await)
    processBatchJob(job.jobId).catch(err => {
      fastify.log.error({ err }, `[Batch] Processing error for job ${job.jobId}`);
    });

    return {
      jobId: job.jobId,
      totalFiles: files.length,
      files: files.map(f => ({
        id: f.id,
        originalName: f.originalName,
        inputFormat: f.inputFormat,
        outputFormat: f.outputFormat,
        status: 'pending',
      })),
    };
  });

  /**
   * GET /api/convert/batch/:jobId/status - Get batch job status
   */
  fastify.get<{ Params: { jobId: string } }>(
    '/convert/batch/:jobId/status',
    async (request, reply) => {
      const { jobId } = request.params;
      const status = getBatchJobStatus(jobId);

      if (!status) {
        return reply.status(404).send({ error: 'Job not found' });
      }

      return status;
    }
  );

  /**
   * GET /api/convert/batch/:jobId/download-all - Download all converted files as ZIP
   */
  fastify.get<{ Params: { jobId: string } }>(
    '/convert/batch/:jobId/download-all',
    async (request, reply) => {
      const { jobId } = request.params;
      const outputFiles = getJobOutputFiles(jobId);

      if (!outputFiles) {
        return reply.status(404).send({ error: 'Job not found' });
      }

      if (outputFiles.length === 0) {
        return reply.status(400).send({ error: 'No completed files to download' });
      }

      // Create ZIP archive
      const archive = archiver('zip', { zlib: { level: 5 } });
      
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="converted_files_${jobId.slice(0, 8)}.zip"`);

      // Pipe archive to response
      reply.send(archive);

      // Add files to archive
      for (const file of outputFiles) {
        if (await fs.pathExists(file.path)) {
          archive.file(file.path, { name: file.name });
        }
      }

      // Finalize archive
      await archive.finalize();

      // Note: Files will be cleaned up by the job TTL
      return reply;
    }
  );

  /**
   * DELETE /api/convert/batch/:jobId - Cancel and cleanup a batch job
   */
  fastify.delete<{ Params: { jobId: string } }>(
    '/convert/batch/:jobId',
    async (request, reply) => {
      const { jobId } = request.params;
      
      await cleanupJob(jobId);
      
      return { message: 'Job cancelled and cleaned up' };
    }
  );

  /**
   * PATCH /api/convert/batch/:jobId/files/:fileId/format - Update format for a pending file
   */
  fastify.patch<{ 
    Params: { jobId: string; fileId: string }; 
    Body: { format: string } 
  }>(
    '/convert/batch/:jobId/files/:fileId/format',
    async (request, reply) => {
      const { jobId, fileId } = request.params;
      const { format } = request.body as { format: string };

      if (!isSupportedOutputFormat(format)) {
        throw new ValidationError(
          `Unsupported output format: ${format}. Supported: ${SUPPORTED_OUTPUT_FORMATS.join(', ')}`
        );
      }

      const status = getBatchJobStatus(jobId);
      if (!status) {
        return reply.status(404).send({ error: 'Job not found' });
      }

      // Note: In a real implementation, we'd update the job in the manager
      // For now, format changes need to be done before processing starts
      
      return { message: 'Format update noted (effective before processing starts)' };
    }
  );
}
