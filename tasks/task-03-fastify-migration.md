# Task 03: Fastify + TypeScript Migration

## 📋 Task Overview

| Field | Value |
|-------|-------|
| **Task ID** | TASK-03 |
| **Priority** | 🟡 HIGH |
| **Estimated Time** | 2-3 days |
| **Dependencies** | Task 01, Task 02 |
| **Blocks** | Task 04, Task 05 |

## 🎯 Objectives

1. Set up TypeScript in the server
2. Replace Express with Fastify
3. Replace `exec()` with `spawn()` (security fix)
4. Implement proper folder structure
5. Add schema validation
6. Add health check endpoints

---

## ✅ Prerequisites

- [x] Task 01 completed (Docker Optimization)
- [x] Task 02 completed (ODA binary installed in Docker)
- [x] Node.js 20+ installed locally for development
- [x] Basic TypeScript knowledge

---

## ⚠️ IMPORTANT: Dockerfile Updates Required

This task changes the server structure significantly. You **MUST** update the Dockerfile after completing this task:

### Changes Needed:

1. **Entry Point**: `server/index.js` → `server/dist/server.js`
2. **Package.json**: Root `package.json` → `server/package.json`
3. **Build Step**: Must compile TypeScript before copying

### Updated Dockerfile Section (apply after Step 12):

```dockerfile
# ============ BUILD STAGE ============
FROM node:20-slim AS builder

# Build server (TypeScript)
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# Build client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client ./
RUN npm run build

# ============ RUNTIME STAGE ============
# ... (keep existing runtime setup from Task 01) ...

# Copy built assets
WORKDIR /usr/src/app
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/client/dist ./client/dist
COPY scripts ./scripts

# ⚠️ UPDATED ENTRY POINT
CMD ["node", "server/dist/server.js"]
```

---

## 📝 Step-by-Step Instructions

### Step 1: Initialize New Server Structure

```bash
# Create new server directory structure
mkdir -p server/src/{config,plugins,common,modules/{conversion,files,health}}
mkdir -p server/src/modules/conversion/providers

# Create TypeScript config
cd server
npm init -y
```

### Step 2: Install Dependencies

```bash
# In /server directory
npm install fastify @fastify/cors @fastify/multipart @fastify/static
npm install fs-extra p-limit
npm install -D typescript @types/node @types/fs-extra ts-node nodemon
```

### Step 3: Create TypeScript Configuration

Create `server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Step 4: Create Package.json Scripts

Update `server/package.json`:

```json
{
  "name": "3d-converter-server",
  "version": "1.0.0",
  "main": "dist/server.js",
  "scripts": {
    "dev": "nodemon --exec ts-node src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "fastify": "^4.26.0",
    "@fastify/cors": "^9.0.0",
    "@fastify/multipart": "^8.1.0",
    "@fastify/static": "^7.0.0",
    "fs-extra": "^11.2.0",
    "p-limit": "^3.1.0"
  },
  "devDependencies": {
    "@types/fs-extra": "^11.0.4",
    "@types/node": "^20.11.0",
    "nodemon": "^3.0.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.3.0"
  }
}
```

### Step 5: Create Configuration Module

Create `server/src/config/env.ts`:

```typescript
/**
 * Environment configuration with validation
 */

export interface Config {
  port: number;
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
  uploadDir: string;
  maxFileSize: number; // in bytes
  conversionTimeout: number; // in ms
  maxConcurrentBlender: number;
  maxConcurrentAssimp: number;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number`);
  }
  return parsed;
}

export const config: Config = {
  port: getEnvNumber('PORT', 3001),
  host: getEnvVar('HOST', '0.0.0.0'),
  nodeEnv: getEnvVar('NODE_ENV', 'development') as Config['nodeEnv'],
  uploadDir: getEnvVar('UPLOAD_DIR', './data/uploads'),
  maxFileSize: getEnvNumber('MAX_FILE_SIZE', 100 * 1024 * 1024), // 100MB
  conversionTimeout: getEnvNumber('CONVERSION_TIMEOUT', 5 * 60 * 1000), // 5 minutes
  maxConcurrentBlender: getEnvNumber('MAX_CONCURRENT_BLENDER', 2),
  maxConcurrentAssimp: getEnvNumber('MAX_CONCURRENT_ASSIMP', 5),
};

export default config;
```

### Step 6: Create Common Utilities

Create `server/src/common/constants.ts`:

```typescript
/**
 * Application constants
 */

// Supported file formats
export const SUPPORTED_INPUT_FORMATS = ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'] as const;
export const SUPPORTED_OUTPUT_FORMATS = ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'] as const;

// Format categories
export const SIMPLE_MESH_FORMATS = ['obj', 'stl', 'ply', 'glb', 'gltf'] as const;
export const CAD_FORMATS = ['dxf', 'dwg'] as const;

// File size limits
export const MAX_FILE_SIZE_MB = 100;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Paths
export const BLENDER_SCRIPT_PATH = '/usr/src/app/scripts/blender/export.py';

export type InputFormat = typeof SUPPORTED_INPUT_FORMATS[number];
export type OutputFormat = typeof SUPPORTED_OUTPUT_FORMATS[number];
```

Create `server/src/common/errors.ts`:

```typescript
/**
 * Custom error classes
 */

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR'
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ConversionError extends AppError {
  constructor(message: string, public details?: string) {
    super(message, 500, 'CONVERSION_ERROR');
    this.name = 'ConversionError';
  }
}

export class TimeoutError extends AppError {
  constructor(message: string = 'Operation timed out') {
    super(message, 408, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}
```

Create `server/src/common/utils.ts`:

```typescript
/**
 * Utility functions
 */

import path from 'path';
import crypto from 'crypto';

/**
 * Get file extension without dot, lowercase
 */
export function getExtension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * Generate unique filename
 */
export function generateUniqueFilename(originalName: string): string {
  const ext = path.extname(originalName);
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `${timestamp}-${random}${ext}`;
}

/**
 * Check if format is a simple mesh (Assimp can handle)
 */
export function isSimpleMesh(format: string): boolean {
  const simpleMeshFormats = ['obj', 'stl', 'ply', 'glb', 'gltf'];
  return simpleMeshFormats.includes(format.toLowerCase());
}

/**
 * Check if format is CAD
 */
export function isCadFormat(format: string): boolean {
  const cadFormats = ['dxf', 'dwg'];
  return cadFormats.includes(format.toLowerCase());
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Step 7: Create Blender Provider (with spawn)

Create `server/src/modules/conversion/providers/blender.provider.ts`:

```typescript
/**
 * Blender Provider - Handles 3D conversions using Blender CLI
 * 
 * SECURITY: Uses spawn() instead of exec() to prevent command injection
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { ConversionError, TimeoutError } from '../../../common/errors';
import config from '../../../config/env';
import pLimit from 'p-limit';

// Limit concurrent Blender processes to prevent OOM
const blenderLimit = pLimit(config.maxConcurrentBlender);

interface BlenderConversionOptions {
  timeout?: number;
}

/**
 * Convert a 3D file using Blender
 * 
 * @param inputPath - Absolute path to input file
 * @param outputPath - Absolute path for output file
 * @param options - Conversion options
 */
export async function blenderConvert(
  inputPath: string,
  outputPath: string,
  options: BlenderConversionOptions = {}
): Promise<string> {
  const { timeout = config.conversionTimeout } = options;

  // Use p-limit to queue heavy conversions
  return blenderLimit(() => executeBlender(inputPath, outputPath, timeout));
}

async function executeBlender(
  inputPath: string,
  outputPath: string,
  timeout: number
): Promise<string> {
  const inputFormat = path.extname(inputPath).slice(1).toLowerCase();
  const outputFormat = path.extname(outputPath).slice(1).toLowerCase();

  console.log(`[Blender] Converting ${inputFormat} → ${outputFormat}`);
  console.log(`[Blender] Input: ${inputPath}`);
  console.log(`[Blender] Output: ${outputPath}`);

  return new Promise((resolve, reject) => {
    // Environment variables for the Python script
    const env = {
      ...process.env,
      INPUT_FILE_PATH: inputPath,
      INPUT_FILE_FORMAT: inputFormat,
      OUTPUT_FILE_PATH: outputPath,
      OUTPUT_FILE_FORMAT: outputFormat,
    };

    // ✅ SECURE: Using spawn with arguments array (no shell injection possible)
    const proc: ChildProcess = spawn('blender', [
      '--background',        // Run without GUI
      '-noaudio',           // Disable audio
      '--python', '/usr/src/app/scripts/blender/export.py'
    ], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Set timeout
    const timeoutId = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new TimeoutError(`Blender conversion timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new ConversionError(`Blender process error: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);

      if (killed) return; // Already rejected due to timeout

      if (code !== 0) {
        console.error(`[Blender] Exit code: ${code}`);
        console.error(`[Blender] stderr: ${stderr}`);
        reject(new ConversionError(
          `Blender conversion failed with exit code ${code}`,
          stderr
        ));
        return;
      }

      console.log(`[Blender] Conversion successful`);
      resolve(outputPath);
    });
  });
}

/**
 * Check if Blender is available
 */
export async function isBlenderAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('blender', ['--version']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}
```

### Step 8: Create Assimp Provider

Create `server/src/modules/conversion/providers/assimp.provider.ts`:

```typescript
/**
 * Assimp Provider - Fast lightweight 3D conversions
 */

import { spawn } from 'child_process';
import path from 'path';
import { ConversionError } from '../../../common/errors';
import config from '../../../config/env';
import pLimit from 'p-limit';

// Assimp is lighter, allow more concurrent processes
const assimpLimit = pLimit(config.maxConcurrentAssimp);

/**
 * Convert a 3D file using Assimp
 */
export async function assimpConvert(
  inputPath: string,
  outputPath: string
): Promise<string> {
  return assimpLimit(() => executeAssimp(inputPath, outputPath));
}

async function executeAssimp(
  inputPath: string,
  outputPath: string
): Promise<string> {
  const inputFormat = path.extname(inputPath).slice(1).toLowerCase();
  const outputFormat = path.extname(outputPath).slice(1).toLowerCase();

  console.log(`[Assimp] Converting ${inputFormat} → ${outputFormat}`);

  return new Promise((resolve, reject) => {
    // ✅ SECURE: Using spawn with arguments array
    const proc = spawn('assimp', [
      'export',
      inputPath,
      outputPath
    ]);

    let stderr = '';

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new ConversionError(`Assimp process error: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new ConversionError(
          `Assimp conversion failed with exit code ${code}`,
          stderr
        ));
        return;
      }

      console.log(`[Assimp] Conversion successful`);
      resolve(outputPath);
    });
  });
}

/**
 * Check if Assimp is available
 */
export async function isAssimpAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('assimp', ['version']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}
```

### Step 9: Create Health Routes

Create `server/src/modules/health/health.route.ts`:

```typescript
/**
 * Health check routes
 */

import { FastifyInstance } from 'fastify';
import { isBlenderAvailable } from '../conversion/providers/blender.provider';
import { isAssimpAvailable } from '../conversion/providers/assimp.provider';

export async function healthRoutes(fastify: FastifyInstance) {
  // Basic health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Detailed readiness check
  fastify.get('/ready', async () => {
    const [blender, assimp] = await Promise.all([
      isBlenderAvailable(),
      isAssimpAvailable(),
    ]);

    const allReady = blender && assimp;

    return {
      status: allReady ? 'ready' : 'degraded',
      checks: {
        blender: blender ? 'ok' : 'unavailable',
        assimp: assimp ? 'ok' : 'unavailable',
      },
      timestamp: new Date().toISOString(),
    };
  });
}
```

### Step 10: Create App Setup

Create `server/src/app.ts`:

```typescript
/**
 * Fastify App Setup
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';

import config from './config/env';
import { healthRoutes } from './modules/health/health.route';
import { AppError } from './common/errors';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    // Generous timeout for large file conversions
    connectionTimeout: config.conversionTimeout,
    keepAliveTimeout: config.conversionTimeout,
  });

  // Register plugins
  await app.register(cors, {
    origin: true,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxFileSize,
    },
  });

  // Serve static files in production
  if (config.nodeEnv === 'production') {
    await app.register(fastifyStatic, {
      root: path.join(__dirname, '../../client/dist'),
      prefix: '/',
    });
  }

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
    }

    // Fastify validation errors
    if (error.validation) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: error.message,
      });
    }

    // Unknown errors
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: config.nodeEnv === 'production' 
        ? 'Internal server error' 
        : error.message,
    });
  });

  // Register routes
  await app.register(healthRoutes);

  // TODO: Register conversion routes (Task 04)
  // await app.register(conversionRoutes, { prefix: '/api' });

  return app;
}
```

### Step 11: Create Server Entry Point

Create `server/src/server.ts`:

```typescript
/**
 * Server Entry Point
 */

import { buildApp } from './app';
import config from './config/env';
import fs from 'fs-extra';
import path from 'path';

async function main() {
  // Ensure upload directory exists
  const uploadDir = path.resolve(config.uploadDir);
  await fs.ensureDir(uploadDir);
  console.log(`Upload directory: ${uploadDir}`);

  // Build and start the app
  const app = await buildApp();

  try {
    await app.listen({
      port: config.port,
      host: config.host,
    });

    console.log(`🚀 Server running at http://${config.host}:${config.port}`);
    console.log(`📁 Environment: ${config.nodeEnv}`);
    console.log(`⚙️  Max concurrent Blender: ${config.maxConcurrentBlender}`);
    console.log(`⚙️  Max concurrent Assimp: ${config.maxConcurrentAssimp}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
```

### Step 12: Update Root package.json

Update the root `package.json` to point to new server:

```json
{
  "scripts": {
    "server": "cd server && npm run dev",
    "server:build": "cd server && npm run build",
    "start:prod": "cd server && npm start"
  }
}
```

### Step 13: Build and Test Locally

```bash
# Install dependencies
cd server && npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev

# Test endpoints
curl http://localhost:3001/health
curl http://localhost:3001/ready
```

### Step 14: Update Dockerfile for TypeScript

> ⚠️ **CRITICAL**: Apply the Dockerfile changes from the "Important" section above!

```bash
# After updating Dockerfile, rebuild
docker build -t 3d-converter:fastify .

# Test the new image
docker run -d --name converter-test -p 3001:3001 3d-converter:fastify

# Verify it works
curl http://localhost:3001/health
curl http://localhost:3001/ready

# Check logs
docker logs converter-test

# Cleanup
docker stop converter-test && docker rm converter-test
```


### Recommended Server Folder Structure (Fastify + TypeScript)

```
/server
├── package.json
├── tsconfig.json               # TypeScript Config
├── .env                        # Environment variables
└── src/
    ├── app.ts                  # App Setup (Plugins, Global Middleware)
    ├── server.ts               # Entry Point (Starts the listener)
    │
    ├── config/                 # Config loader (Validates .env vars)
    │   └── env.ts
    │
    ├── plugins/                # Global Fastify Plugins
    │   ├── cors.ts
    │   ├── multipart.ts        # File upload handling
    │   └── swagger.ts          # (Optional) API Documentation
    │
    ├── common/                 # Shared Code
    │   ├── constants.ts        # File formats, paths, etc.
    │   ├── errors.ts           # Custom error classes
    │   └── utils.ts            # Helper functions
    │
    └── modules/                # ✨ THE CORE LOGIC (Feature-based)
        │
        ├── conversion/         # 🔄 All 3D Conversion Logic
        │   ├── conversion.route.ts     # URLs: POST /api/convert
        │   ├── conversion.schema.ts    # Input Validation (Zod/TypeBox)
        │   ├── conversion.service.ts   # The logic (Calls Blender/Assimp)
        │   └── providers/              # Adapters for specific tools
        │       ├── blender.provider.ts   # Blender CLI wrapper
        │       ├── assimp.provider.ts    # Assimp CLI wrapper
        │       └── oda.provider.ts       # ODA Converter wrapper
        │
        ├── files/              # 📁 File Management
        │   ├── file.route.ts           # URLs: GET /api/download/:id
        │   ├── file.service.ts         # Upload/download/temp files
        │   └── file.job.ts             # Cleanup Cron Jobs
        │
        └── health/             # ❤️ Health Checks
            └── health.route.ts         # GET /health, GET /ready
```

### Key Architecture Principles

1. **Feature-based modules** - Each feature (conversion, files) is self-contained
2. **Providers pattern** - Each CLI tool (Blender, Assimp, ODA) gets its own wrapper
3. **Schema validation** - Input validated before hitting service layer
4. **Clean separation** - Routes → Service → Provider → CLI


---

## 🧪 Testing Checklist

### TypeScript
- [ ] `npm run build` completes without errors
- [ ] No TypeScript errors in IDE

### Server Startup
- [ ] Server starts on port 3001
- [ ] No deprecation warnings
- [ ] Logger outputs correctly

### Health Endpoints
- [ ] GET /health returns `{ status: 'ok' }`
- [ ] GET /ready shows tool availability

### Security
- [ ] No `exec()` calls remaining
- [ ] All CLI calls use `spawn()`

---

## ✅ Acceptance Criteria

| Criteria | Target | Status |
|----------|--------|--------|
| TypeScript compiles | Yes | ⬜ |
| Fastify runs locally | Yes | ⬜ |
| No exec() usage | Yes | ⬜ |
| Health endpoints work | Yes | ⬜ |
| Error handling works | Yes | ⬜ |
| p-limit implemented | Yes | ⬜ |
| **Dockerfile updated** | CMD points to `dist/server.js` | ⬜ |
| **Docker image builds** | Yes | ⬜ |

---

## 🔗 Related Files

- `server/src/` - All new TypeScript files
- `server/tsconfig.json` - TypeScript config
- `server/package.json` - Dependencies

---

## ⏭️ Next Task

After completing this task, proceed to: **[Task 04: Hybrid Conversion Strategy](./task-04-hybrid-conversion.md)**
