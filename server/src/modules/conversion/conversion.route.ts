/**
 * Conversion Routes - File upload and conversion endpoints
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import fs from 'fs-extra';
import { pipeline } from 'stream/promises';
import { convertFile } from './conversion.service';
import { ValidationError } from '../../common/errors';
import { 
  isSupportedInputFormat, 
  isSupportedOutputFormat,
  SUPPORTED_OUTPUT_FORMATS 
} from '../../common/constants';
import { getExtension, generateUniqueFilename, sanitizeFilename } from '../../common/utils';
import config from '../../config/env';

export async function conversionRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/convert - Upload and convert a 3D file
   */
  fastify.post('/convert', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    
    if (!data) {
      throw new ValidationError('No file uploaded');
    }

    // Get the target format from fields (multipart form data)
    const fields = data.fields as Record<string, { value?: string }>;
    const targetFormat = fields?.format?.value || 'glb';

    // Validate output format
    if (!isSupportedOutputFormat(targetFormat)) {
      throw new ValidationError(
        `Unsupported output format: ${targetFormat}. Supported: ${SUPPORTED_OUTPUT_FORMATS.join(', ')}`
      );
    }

    // Validate input format
    const inputFormat = getExtension(data.filename);
    if (!isSupportedInputFormat(inputFormat)) {
      throw new ValidationError(
        `Unsupported input format: ${inputFormat}. Supported: obj, fbx, gltf, glb, dxf, dwg`
      );
    }

    // Generate unique filename and save to disk
    const safeFilename = sanitizeFilename(data.filename);
    const uniqueFilename = generateUniqueFilename(safeFilename);
    const uploadDir = path.resolve(config.uploadDir);
    const inputPath = path.join(uploadDir, uniqueFilename);

    try {
      // Ensure upload directory exists
      await fs.ensureDir(uploadDir);

      // Save uploaded file
      await pipeline(data.file, fs.createWriteStream(inputPath));

      fastify.log.info(`File uploaded: ${uniqueFilename}`);

      // Perform conversion
      const result = await convertFile(inputPath, targetFormat);

      // Delete input file after conversion
      await fs.remove(inputPath).catch(err => {
        fastify.log.warn(`Failed to delete input file: ${err.message}`);
      });

      const outputFilename = path.basename(result.outputPath);

      return {
        message: 'Conversion successful',
        downloadUrl: `/api/download/${outputFilename}`,
        tool: result.tool,
        duration: result.duration,
      };
    } catch (error) {
      // Cleanup input file on error
      await fs.remove(inputPath).catch(() => {});
      throw error;
    }
  });

  /**
   * GET /api/download/:filename - Download a converted file
   */
  fastify.get<{ Params: { filename: string } }>(
    '/download/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      
      // Sanitize filename to prevent path traversal
      const safeFilename = sanitizeFilename(filename);
      const filePath = path.join(path.resolve(config.uploadDir), safeFilename);

      // Check if file exists
      if (!await fs.pathExists(filePath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      // Set headers for download
      const ext = getExtension(filename);
      reply.header('Content-Disposition', `attachment; filename="${safeFilename}"`);
      reply.header('Content-Type', 'application/octet-stream');

      // Stream the file
      const stream = fs.createReadStream(filePath);
      
      // Delete file after sending (fire and forget)
      stream.on('end', () => {
        fs.remove(filePath).catch(err => {
          fastify.log.warn(`Failed to delete output file: ${err.message}`);
        });
      });

      return reply.send(stream);
    }
  );

  /**
   * POST /api/cleanup - Manual cleanup of all uploaded files
   */
  fastify.post('/cleanup', async (request, reply) => {
    const uploadDir = path.resolve(config.uploadDir);
    
    try {
      const files = await fs.readdir(uploadDir);
      let deleted = 0;
      
      for (const file of files) {
        if (file === '.keep' || file === '.gitkeep') continue;
        await fs.remove(path.join(uploadDir, file));
        deleted++;
      }
      
      return { 
        message: 'Cleanup successful', 
        filesDeleted: deleted 
      };
    } catch (error) {
      fastify.log.error({ err: error }, 'Cleanup error');
      throw error;
    }
  });

  /**
   * GET /api/formats - List supported formats
   */
  fastify.get('/formats', async () => {
    return {
      input: ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'],
      output: ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'],
    };
  });
}
