# Task 04: Hybrid Conversion Strategy

## 📋 Task Overview

| Field | Value |
|-------|-------|
| **Task ID** | TASK-04 |
| **Priority** | 🟡 HIGH |
| **Estimated Time** | 2-3 days |
| **Dependencies** | Task 01, Task 02, Task 03 |
| **Blocks** | Production deployment |

## 🎯 Objectives

1. **Create ODA Provider** (TypeScript version - was skipped in Task 02)
2. Implement "Assimp First, Blender Fallback" strategy
3. Create smart conversion router
4. Handle DWG special cases (ODA pipeline)
5. Implement file upload and download routes
6. Add proper cleanup with try/finally

---

## ✅ Prerequisites

- [ ] Task 01 completed (Docker Optimization)
- [ ] Task 02 completed (ODA binary installed & verified in Docker)
- [ ] Task 03 completed (Fastify + TypeScript Migration)
- [ ] All three tools available in Docker (Blender, Assimp, ODA)

> ⚠️ **NOTE:** The ODA TypeScript provider is created in THIS task (not Task 02).
> Task 02 only verified that the ODA binary works.

---

## 📝 Step-by-Step Instructions

### Step 1: Create ODA Provider (TypeScript version)

Create `server/src/modules/conversion/providers/oda.provider.ts`:

```typescript
/**
 * ODA File Converter Provider
 * Handles DWG ↔ DXF conversions
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { ConversionError } from '../../../common/errors';

interface OdaConversionOptions {
  version?: 'ACAD9' | 'ACAD2000' | 'ACAD2010' | 'ACAD2013' | 'ACAD2018';
  audit?: boolean;
}

/**
 * Convert between DWG and DXF using ODA File Converter
 * 
 * ODA requires directories as input/output, so we create temp directories
 */
export async function odaConvert(
  inputFilePath: string,
  outputFormat: 'DXF' | 'DWG',
  options: OdaConversionOptions = {}
): Promise<string> {
  const { version = 'ACAD2018', audit = true } = options;

  const inputDir = path.dirname(inputFilePath);
  const inputFileName = path.basename(inputFilePath);
  const inputExt = path.extname(inputFilePath).toLowerCase();
  const outputFileName = inputFileName.replace(inputExt, `.${outputFormat.toLowerCase()}`);

  // Validate input format
  if (!['.dwg', '.dxf'].includes(inputExt)) {
    throw new ConversionError(`ODA only supports DWG and DXF. Got: ${inputExt}`);
  }

  // Create temporary directories
  const timestamp = Date.now();
  const tempInputDir = path.join(inputDir, `oda_in_${timestamp}`);
  const tempOutputDir = path.join(inputDir, `oda_out_${timestamp}`);

  await fs.ensureDir(tempInputDir);
  await fs.ensureDir(tempOutputDir);

  // Copy input file to temp input directory
  await fs.copy(inputFilePath, path.join(tempInputDir, inputFileName));

  console.log(`[ODA] Converting ${inputFileName} → ${outputFormat}`);

  try {
    await executeOda(tempInputDir, tempOutputDir, version, outputFormat, audit);

    // Find output file
    const outputFilePath = path.join(tempOutputDir, outputFileName);
    
    if (!await fs.pathExists(outputFilePath)) {
      const files = await fs.readdir(tempOutputDir);
      throw new ConversionError(
        `ODA output file not found. Expected: ${outputFileName}, Found: ${files.join(', ')}`
      );
    }

    // Move to final location
    const finalOutputPath = path.join(inputDir, outputFileName);
    await fs.move(outputFilePath, finalOutputPath, { overwrite: true });

    console.log(`[ODA] Conversion successful: ${finalOutputPath}`);
    return finalOutputPath;

  } finally {
    // Always cleanup temp directories
    await fs.remove(tempInputDir).catch(() => {});
    await fs.remove(tempOutputDir).catch(() => {});
  }
}

function executeOda(
  inputDir: string,
  outputDir: string,
  version: string,
  format: string,
  audit: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    // CRITICAL: Use xvfb-run for headless execution
    const proc = spawn('xvfb-run', [
      '-a',
      'ODAFileConverter',
      inputDir,
      outputDir,
      version,
      format,
      '0',  // Don't recurse
      audit ? '1' : '0'
    ]);

    let stderr = '';

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
      console.log(`[ODA stderr] ${data}`);
    });

    proc.stdout?.on('data', (data) => {
      console.log(`[ODA stdout] ${data}`);
    });

    proc.on('error', (err) => {
      reject(new ConversionError(`ODA process error: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new ConversionError(`ODA failed with code ${code}`, stderr));
        return;
      }
      resolve();
    });
  });
}

/**
 * Convert DWG to DXF
 */
export async function dwgToDxf(dwgPath: string): Promise<string> {
  return odaConvert(dwgPath, 'DXF');
}

/**
 * Convert DXF to DWG
 */
export async function dxfToDwg(dxfPath: string): Promise<string> {
  return odaConvert(dxfPath, 'DWG');
}

/**
 * Check if ODA is available
 */
export async function isOdaAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['ODAFileConverter']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}
```

### Step 2: Create Conversion Service

Create `server/src/modules/conversion/conversion.service.ts`:

```typescript
/**
 * Conversion Service - Smart routing between Assimp, Blender, and ODA
 * 
 * Strategy: "Assimp First, Blender Fallback"
 */

import path from 'path';
import fs from 'fs-extra';
import { blenderConvert } from './providers/blender.provider';
import { assimpConvert } from './providers/assimp.provider';
import { odaConvert, dwgToDxf, dxfToDwg } from './providers/oda.provider';
import { ConversionError, ValidationError } from '../../common/errors';
import { getExtension, isSimpleMesh, isCadFormat } from '../../common/utils';
import { SUPPORTED_INPUT_FORMATS, SUPPORTED_OUTPUT_FORMATS } from '../../common/constants';

export interface ConversionResult {
  outputPath: string;
  converter: 'assimp' | 'blender' | 'oda' | 'oda+blender' | 'blender+oda';
  duration: number;
}

/**
 * Main conversion function - routes to appropriate converter
 */
export async function convertFile(
  inputPath: string,
  outputFormat: string
): Promise<ConversionResult> {
  const startTime = Date.now();
  const inputFormat = getExtension(inputPath);
  const outputFormatLower = outputFormat.toLowerCase();

  // Validate formats
  if (!SUPPORTED_INPUT_FORMATS.includes(inputFormat as any)) {
    throw new ValidationError(`Unsupported input format: ${inputFormat}`);
  }
  if (!SUPPORTED_OUTPUT_FORMATS.includes(outputFormatLower as any)) {
    throw new ValidationError(`Unsupported output format: ${outputFormatLower}`);
  }

  // Same format - just copy
  if (inputFormat === outputFormatLower) {
    throw new ValidationError('Input and output formats are the same');
  }

  const inputDir = path.dirname(inputPath);
  const inputBasename = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(inputDir, `${inputBasename}.${outputFormatLower}`);

  let converter: ConversionResult['converter'];
  let tempFiles: string[] = [];

  try {
    // ═══════════════════════════════════════════════════════════════
    // CASE 1: DWG INPUT - Must go through ODA first
    // ═══════════════════════════════════════════════════════════════
    if (inputFormat === 'dwg') {
      if (outputFormatLower === 'dxf') {
        // DWG → DXF: ODA only (single step)
        await odaConvert(inputPath, 'DXF');
        converter = 'oda';
      } else {
        // DWG → Other: ODA → DXF → Blender
        const dxfPath = await dwgToDxf(inputPath);
        tempFiles.push(dxfPath);
        
        await blenderConvert(dxfPath, outputPath);
        converter = 'oda+blender';
      }
    }
    // ═══════════════════════════════════════════════════════════════
    // CASE 2: DWG OUTPUT - Must go through ODA last
    // ═══════════════════════════════════════════════════════════════
    else if (outputFormatLower === 'dwg') {
      if (inputFormat === 'dxf') {
        // DXF → DWG: ODA only (single step)
        await odaConvert(inputPath, 'DWG');
        converter = 'oda';
      } else {
        // Other → DWG: Blender → DXF → ODA
        const tempDxfPath = path.join(inputDir, `${inputBasename}.temp.dxf`);
        
        await blenderConvert(inputPath, tempDxfPath);
        tempFiles.push(tempDxfPath);
        
        await dxfToDwg(tempDxfPath);
        converter = 'blender+oda';
      }
    }
    // ═══════════════════════════════════════════════════════════════
    // CASE 3: DXF involved - Blender required
    // ═══════════════════════════════════════════════════════════════
    else if (inputFormat === 'dxf' || outputFormatLower === 'dxf') {
      await blenderConvert(inputPath, outputPath);
      converter = 'blender';
    }
    // ═══════════════════════════════════════════════════════════════
    // CASE 4: Simple mesh formats - Try Assimp first
    // ═══════════════════════════════════════════════════════════════
    else if (isSimpleMesh(inputFormat) && isSimpleMesh(outputFormatLower)) {
      try {
        console.log('[Router] Attempting fast conversion via Assimp...');
        await assimpConvert(inputPath, outputPath);
        converter = 'assimp';
      } catch (assimpError) {
        console.warn('[Router] Assimp failed, falling back to Blender:', assimpError);
        await blenderConvert(inputPath, outputPath);
        converter = 'blender';
      }
    }
    // ═══════════════════════════════════════════════════════════════
    // CASE 5: Complex formats (FBX with textures, etc.) - Blender
    // ═══════════════════════════════════════════════════════════════
    else {
      // FBX and GLTF with materials/animations need Blender
      await blenderConvert(inputPath, outputPath);
      converter = 'blender';
    }

    // Verify output exists
    if (!await fs.pathExists(outputPath)) {
      throw new ConversionError('Conversion completed but output file not found');
    }

    const duration = Date.now() - startTime;
    console.log(`[Router] Conversion complete: ${converter} in ${duration}ms`);

    return { outputPath, converter, duration };

  } finally {
    // ═══════════════════════════════════════════════════════════════
    // CLEANUP: Always delete temp files
    // ═══════════════════════════════════════════════════════════════
    for (const tempFile of tempFiles) {
      await fs.remove(tempFile).catch((err) => {
        console.warn(`[Cleanup] Failed to delete temp file ${tempFile}:`, err);
      });
    }
  }
}

/**
 * Get the expected converter for a conversion (for UI hints)
 */
export function getExpectedConverter(
  inputFormat: string,
  outputFormat: string
): 'assimp' | 'blender' | 'oda' | 'oda+blender' | 'blender+oda' {
  const input = inputFormat.toLowerCase();
  const output = outputFormat.toLowerCase();

  if (input === 'dwg' && output === 'dxf') return 'oda';
  if (input === 'dxf' && output === 'dwg') return 'oda';
  if (input === 'dwg') return 'oda+blender';
  if (output === 'dwg') return 'blender+oda';
  if (input === 'dxf' || output === 'dxf') return 'blender';
  if (isSimpleMesh(input) && isSimpleMesh(output)) return 'assimp';
  return 'blender';
}
```

### Step 3: Create Conversion Schema

Create `server/src/modules/conversion/conversion.schema.ts`:

```typescript
/**
 * Request/Response schemas for conversion endpoints
 */

export const convertRequestSchema = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      enum: ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'],
      description: 'Target output format'
    }
  },
  required: ['format']
};

export const convertResponseSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    downloadUrl: { type: 'string' },
    converter: { type: 'string' },
    duration: { type: 'number' }
  }
};

export const downloadParamsSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string' }
  },
  required: ['filename']
};
```

### Step 4: Create Conversion Routes

Create `server/src/modules/conversion/conversion.route.ts`:

```typescript
/**
 * Conversion API Routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import fs from 'fs-extra';
import { pipeline } from 'stream/promises';
import { convertFile } from './conversion.service';
import { generateUniqueFilename } from '../../common/utils';
import { ValidationError, NotFoundError } from '../../common/errors';
import config from '../../config/env';

export async function conversionRoutes(fastify: FastifyInstance) {
  const uploadDir = path.resolve(config.uploadDir);

  // ═══════════════════════════════════════════════════════════════
  // POST /api/convert - Upload and convert file
  // ═══════════════════════════════════════════════════════════════
  fastify.post('/convert', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    
    if (!data) {
      throw new ValidationError('No file uploaded');
    }

    // Get target format from fields
    const fields = data.fields as any;
    const formatField = fields.format;
    const targetFormat = formatField?.value || 'glb';

    // Generate unique filename
    const uniqueFilename = generateUniqueFilename(data.filename);
    const inputPath = path.join(uploadDir, uniqueFilename);

    // Save uploaded file
    await fs.ensureDir(uploadDir);
    await pipeline(data.file, fs.createWriteStream(inputPath));

    console.log(`[Upload] Saved: ${inputPath}`);

    let outputPath: string | null = null;

    try {
      // Run conversion
      const result = await convertFile(inputPath, targetFormat);
      outputPath = result.outputPath;

      const outputFilename = path.basename(outputPath);

      return {
        message: 'Conversion successful',
        downloadUrl: `/api/download/${outputFilename}`,
        converter: result.converter,
        duration: result.duration
      };

    } finally {
      // ═══════════════════════════════════════════════════════════
      // CLEANUP: Always delete input file after conversion
      // ═══════════════════════════════════════════════════════════
      await fs.remove(inputPath).catch((err) => {
        console.warn(`[Cleanup] Failed to delete input file:`, err);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/download/:filename - Download converted file
  // ═══════════════════════════════════════════════════════════════
  fastify.get<{ Params: { filename: string } }>(
    '/download/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      
      // Security: Prevent directory traversal
      const safeName = path.basename(filename);
      const filePath = path.join(uploadDir, safeName);

      if (!await fs.pathExists(filePath)) {
        throw new NotFoundError('File not found or already downloaded');
      }

      // Send file and delete after
      const stream = fs.createReadStream(filePath);
      
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      
      // Delete file after sending
      stream.on('close', async () => {
        await fs.remove(filePath).catch((err) => {
          console.warn(`[Cleanup] Failed to delete output file:`, err);
        });
        console.log(`[Download] Sent and deleted: ${safeName}`);
      });

      return reply.send(stream);
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // POST /api/cleanup - Manual cleanup (admin)
  // ═══════════════════════════════════════════════════════════════
  fastify.post('/cleanup', async () => {
    const files = await fs.readdir(uploadDir);
    let deleted = 0;

    for (const file of files) {
      if (file === '.keep' || file === '.gitkeep') continue;
      await fs.remove(path.join(uploadDir, file));
      deleted++;
    }

    return { message: 'Cleanup complete', filesDeleted: deleted };
  });
}
```

### Step 5: Create File Cleanup Job

Create `server/src/modules/files/file.job.ts`:

```typescript
/**
 * File cleanup scheduled job
 */

import fs from 'fs-extra';
import path from 'path';
import config from '../../config/env';

// Cleanup interval: every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;

// Delete files older than 30 minutes
const FILE_MAX_AGE = 30 * 60 * 1000;

/**
 * Clean up old files from upload directory
 */
async function cleanupOldFiles(): Promise<number> {
  const uploadDir = path.resolve(config.uploadDir);
  let deletedCount = 0;

  try {
    const files = await fs.readdir(uploadDir);
    const now = Date.now();

    for (const file of files) {
      // Skip keep files
      if (file === '.keep' || file === '.gitkeep') continue;

      const filePath = path.join(uploadDir, file);

      try {
        const stats = await fs.stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > FILE_MAX_AGE) {
          await fs.remove(filePath);
          deletedCount++;
          console.log(`[Cleanup Job] Deleted old file: ${file} (age: ${Math.round(age / 1000 / 60)}min)`);
        }
      } catch (err) {
        // File might have been deleted by another process
        continue;
      }
    }
  } catch (err) {
    console.error('[Cleanup Job] Error during cleanup:', err);
  }

  return deletedCount;
}

/**
 * Start the cleanup job
 */
export function startCleanupJob(): void {
  console.log(`[Cleanup Job] Starting (interval: ${CLEANUP_INTERVAL / 1000 / 60}min, max age: ${FILE_MAX_AGE / 1000 / 60}min)`);

  // Run immediately on startup
  cleanupOldFiles().then((count) => {
    console.log(`[Cleanup Job] Initial cleanup: ${count} files deleted`);
  });

  // Run periodically
  setInterval(async () => {
    const count = await cleanupOldFiles();
    if (count > 0) {
      console.log(`[Cleanup Job] Periodic cleanup: ${count} files deleted`);
    }
  }, CLEANUP_INTERVAL);
}
```

### Step 6: Update App to Register Routes

Update `server/src/app.ts`:

```typescript
// Add import
import { conversionRoutes } from './modules/conversion/conversion.route';
import { startCleanupJob } from './modules/files/file.job';

// In buildApp function, after health routes:
await app.register(conversionRoutes, { prefix: '/api' });

// Start cleanup job
startCleanupJob();
```

### Step 7: Test the Complete Flow

```bash
# Build and start
cd server
npm run build
npm start

# Test health
curl http://localhost:3001/health

# Test conversion (OBJ to GLB)
curl -X POST \
  -F "file=@test.obj" \
  -F "format=glb" \
  http://localhost:3001/api/convert

# Should return: { downloadUrl: "/api/download/xxx.glb", converter: "assimp", ... }
```

---

## 🧪 Testing Checklist

### Conversion Matrix
- [ ] OBJ → GLB (Assimp)
- [ ] OBJ → FBX (Assimp or Blender)
- [ ] FBX → GLB (Assimp fallback to Blender)
- [ ] GLB → OBJ (Assimp)
- [ ] DWG → DXF (ODA)
- [ ] DXF → DWG (ODA)
- [ ] DWG → GLB (ODA + Blender)
- [ ] GLB → DWG (Blender + ODA)
- [ ] DXF → GLB (Blender)
- [ ] GLB → DXF (Blender)

### Cleanup
- [ ] Input files deleted after conversion
- [ ] Temp files deleted on error
- [ ] Output files deleted after download
- [ ] Scheduled cleanup works

### Error Handling
- [ ] Invalid format shows error
- [ ] Missing file shows error
- [ ] Conversion failure is handled

---

## ✅ Acceptance Criteria

| Criteria | Target | Status |
|----------|--------|--------|
| All format conversions work | Yes | ⬜ |
| Assimp used for simple meshes | Yes | ⬜ |
| Blender fallback works | Yes | ⬜ |
| DWG pipeline works | Yes | ⬜ |
| Cleanup works properly | Yes | ⬜ |
| try/finally cleanup | Yes | ⬜ |

---

## 🔗 Related Files

- `server/src/modules/conversion/` - All conversion logic
- `server/src/modules/files/file.job.ts` - Cleanup job
- `server/src/app.ts` - Route registration

---

## ⏭️ Next Task

After completing this task, proceed to: **[Task 05: Production Safeguards](./task-05-production-safeguards.md)**
