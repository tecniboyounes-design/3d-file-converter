# Task 06: Job Queue (Optional Enhancement)

## 📋 Task Overview

| Field | Value |
|-------|-------|
| **Task ID** | TASK-06 |
| **Priority** | 🟢 OPTIONAL |
| **Estimated Time** | 1-2 days |
| **Dependencies** | Task 01-05 |
| **Blocks** | None (Enhancement) |

## 🎯 Objectives

1. Set up Redis for job queue
2. Implement BullMQ for background processing
3. Add async conversion flow (submit → poll → download)
4. Add job status endpoint
5. Handle long-running conversions gracefully

---

## ⚠️ When to Implement

**Implement this task if:**
- You expect many concurrent users
- Conversions frequently take > 1 minute
- You need to support very large files
- You want to show progress to users

**Skip this task if:**
- You have few users
- Most conversions are quick (< 30 seconds)
- Simplicity is more important than scalability

---

## ✅ Prerequisites

- [ ] Task 01-05 completed
- [ ] Redis available (local or Docker)
- [ ] Understanding of job queues

---

## 📝 Step-by-Step Instructions

### Step 1: Add Redis to Docker Compose

Update `docker-compose.yml`:

```yaml
version: "3.8"
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: app
    image: 3d-file-converter
    ports:
      - "3001:3001"
    volumes:
      - ./data:/usr/src/app/data
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    container_name: redis
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

volumes:
  redis_data:
```

### Step 2: Install BullMQ

```bash
cd server
npm install bullmq ioredis
npm install -D @types/ioredis
```

### Step 3: Create Queue Configuration

Create `server/src/config/redis.ts`:

```typescript
/**
 * Redis configuration for BullMQ
 */

import { ConnectionOptions } from 'bullmq';

export const redisConnection: ConnectionOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null, // Required by BullMQ
};

export const queueNames = {
  CONVERSION: 'conversion-queue',
} as const;
```

### Step 4: Create Conversion Queue

Create `server/src/modules/conversion/conversion.queue.ts`:

```typescript
/**
 * Conversion Job Queue using BullMQ
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { redisConnection, queueNames } from '../../config/redis';
import { convertFile, ConversionResult } from './conversion.service';
import path from 'path';
import fs from 'fs-extra';

// ═══════════════════════════════════════════════════════════════
// Job Data Types
// ═══════════════════════════════════════════════════════════════

export interface ConversionJobData {
  inputPath: string;
  outputFormat: string;
  originalFilename: string;
}

export interface ConversionJobResult {
  outputPath: string;
  outputFilename: string;
  converter: string;
  duration: number;
}

// ═══════════════════════════════════════════════════════════════
// Queue Instance
// ═══════════════════════════════════════════════════════════════

export const conversionQueue = new Queue<ConversionJobData, ConversionJobResult>(
  queueNames.CONVERSION,
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 2,           // Retry once on failure
      backoff: {
        type: 'exponential',
        delay: 5000,         // 5 second initial delay
      },
      removeOnComplete: {
        age: 3600,           // Keep completed jobs for 1 hour
        count: 100,          // Keep last 100 completed jobs
      },
      removeOnFail: {
        age: 86400,          // Keep failed jobs for 24 hours
      },
    },
  }
);

// Queue Events for monitoring
export const queueEvents = new QueueEvents(queueNames.CONVERSION, {
  connection: redisConnection,
});

// ═══════════════════════════════════════════════════════════════
// Worker (processes jobs)
// ═══════════════════════════════════════════════════════════════

export function createWorker(): Worker<ConversionJobData, ConversionJobResult> {
  const worker = new Worker<ConversionJobData, ConversionJobResult>(
    queueNames.CONVERSION,
    async (job: Job<ConversionJobData>) => {
      const { inputPath, outputFormat, originalFilename } = job.data;

      console.log(`[Worker] Processing job ${job.id}: ${originalFilename} → ${outputFormat}`);

      // Update progress
      await job.updateProgress(10);

      try {
        // Run conversion
        await job.updateProgress(20);
        const result = await convertFile(inputPath, outputFormat);
        await job.updateProgress(90);

        const outputFilename = path.basename(result.outputPath);

        console.log(`[Worker] Job ${job.id} completed in ${result.duration}ms`);
        await job.updateProgress(100);

        return {
          outputPath: result.outputPath,
          outputFilename,
          converter: result.converter,
          duration: result.duration,
        };
      } catch (error) {
        console.error(`[Worker] Job ${job.id} failed:`, error);
        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency: 2, // Process 2 jobs at a time (matches p-limit)
    }
  );

  // Worker event handlers
  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[Worker] Error:', err);
  });

  return worker;
}

// ═══════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════

/**
 * Add a conversion job to the queue
 */
export async function addConversionJob(
  inputPath: string,
  outputFormat: string,
  originalFilename: string
): Promise<Job<ConversionJobData>> {
  const job = await conversionQueue.add(
    'convert',
    { inputPath, outputFormat, originalFilename },
    {
      jobId: `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    }
  );

  console.log(`[Queue] Job ${job.id} added: ${originalFilename} → ${outputFormat}`);
  return job;
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string) {
  const job = await conversionQueue.getJob(jobId);

  if (!job) {
    return null;
  }

  const state = await job.getState();
  const progress = job.progress;

  return {
    id: job.id,
    state,
    progress,
    data: job.data,
    result: job.returnvalue,
    failedReason: job.failedReason,
    createdAt: job.timestamp,
    processedAt: job.processedOn,
    finishedAt: job.finishedOn,
  };
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    conversionQueue.getWaitingCount(),
    conversionQueue.getActiveCount(),
    conversionQueue.getCompletedCount(),
    conversionQueue.getFailedCount(),
  ]);

  return { waiting, active, completed, failed };
}
```

### Step 5: Create Async Conversion Routes

Create `server/src/modules/conversion/conversion.async.route.ts`:

```typescript
/**
 * Async Conversion Routes (with job queue)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import fs from 'fs-extra';
import { pipeline } from 'stream/promises';
import { addConversionJob, getJobStatus, getQueueStats, conversionQueue } from './conversion.queue';
import { generateUniqueFilename } from '../../common/utils';
import { ValidationError, NotFoundError } from '../../common/errors';
import config from '../../config/env';

export async function asyncConversionRoutes(fastify: FastifyInstance) {
  const uploadDir = path.resolve(config.uploadDir);

  // ═══════════════════════════════════════════════════════════════
  // POST /api/v2/convert - Submit conversion job (returns immediately)
  // ═══════════════════════════════════════════════════════════════
  fastify.post('/v2/convert', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    
    if (!data) {
      throw new ValidationError('No file uploaded');
    }

    const fields = data.fields as any;
    const formatField = fields.format;
    const targetFormat = formatField?.value || 'glb';

    // Save uploaded file
    const uniqueFilename = generateUniqueFilename(data.filename);
    const inputPath = path.join(uploadDir, uniqueFilename);

    await fs.ensureDir(uploadDir);
    await pipeline(data.file, fs.createWriteStream(inputPath));

    // Add job to queue (returns immediately)
    const job = await addConversionJob(inputPath, targetFormat, data.filename);

    // Return job ID for polling
    return {
      message: 'Conversion job submitted',
      jobId: job.id,
      statusUrl: `/api/v2/status/${job.id}`,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/v2/status/:jobId - Check job status
  // ═══════════════════════════════════════════════════════════════
  fastify.get<{ Params: { jobId: string } }>(
    '/v2/status/:jobId',
    async (request, reply) => {
      const { jobId } = request.params;
      const status = await getJobStatus(jobId);

      if (!status) {
        throw new NotFoundError('Job not found');
      }

      // Build response based on state
      const response: any = {
        jobId: status.id,
        status: status.state,
        progress: status.progress,
      };

      if (status.state === 'completed' && status.result) {
        response.downloadUrl = `/api/download/${status.result.outputFilename}`;
        response.converter = status.result.converter;
        response.duration = status.result.duration;
      }

      if (status.state === 'failed') {
        response.error = status.failedReason;
      }

      return response;
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // GET /api/v2/queue/stats - Queue statistics
  // ═══════════════════════════════════════════════════════════════
  fastify.get('/v2/queue/stats', async () => {
    return await getQueueStats();
  });

  // ═══════════════════════════════════════════════════════════════
  // DELETE /api/v2/jobs/:jobId - Cancel a pending job
  // ═══════════════════════════════════════════════════════════════
  fastify.delete<{ Params: { jobId: string } }>(
    '/v2/jobs/:jobId',
    async (request) => {
      const { jobId } = request.params;
      const job = await conversionQueue.getJob(jobId);

      if (!job) {
        throw new NotFoundError('Job not found');
      }

      const state = await job.getState();
      
      if (state === 'active') {
        throw new ValidationError('Cannot cancel active job');
      }

      await job.remove();
      return { message: 'Job cancelled', jobId };
    }
  );
}
```

### Step 6: Update App to Use Queue

Update `server/src/app.ts`:

```typescript
import { asyncConversionRoutes } from './modules/conversion/conversion.async.route';
import { createWorker } from './modules/conversion/conversion.queue';

export async function buildApp(): Promise<FastifyInstance> {
  // ... existing code ...

  // Register both sync and async routes
  await app.register(conversionRoutes, { prefix: '/api' });
  await app.register(asyncConversionRoutes, { prefix: '/api' });

  // Start the worker
  const worker = createWorker();
  console.log('[Queue] Worker started');

  return app;
}
```

### Step 7: Update Environment Config

Add to `server/src/config/env.ts`:

```typescript
export interface Config {
  // ... existing ...
  redisUrl: string;
}

export const config: Config = {
  // ... existing ...
  redisUrl: getEnvVar('REDIS_URL', 'redis://localhost:6379'),
};
```

### Step 8: Client-Side Polling Example

Here's how the frontend would use the async API:

```typescript
// Frontend code example

async function convertFile(file: File, format: string) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('format', format);

  // 1. Submit job
  const submitResponse = await fetch('/api/v2/convert', {
    method: 'POST',
    body: formData,
  });
  const { jobId, statusUrl } = await submitResponse.json();

  // 2. Poll for status
  let status = 'waiting';
  let downloadUrl = null;

  while (status !== 'completed' && status !== 'failed') {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

    const statusResponse = await fetch(statusUrl);
    const statusData = await statusResponse.json();

    status = statusData.status;
    
    // Update progress UI
    if (statusData.progress) {
      updateProgressBar(statusData.progress);
    }

    if (status === 'completed') {
      downloadUrl = statusData.downloadUrl;
    }

    if (status === 'failed') {
      throw new Error(statusData.error);
    }
  }

  // 3. Download file
  if (downloadUrl) {
    window.location.href = downloadUrl;
  }
}
```

### Step 9: Test with Redis

```bash
# Start Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Build and start server
cd server
npm run build
npm start

# Test async endpoint
curl -X POST \
  -F "file=@test.obj" \
  -F "format=glb" \
  http://localhost:3001/api/v2/convert

# Response: { "jobId": "conv-123...", "statusUrl": "/api/v2/status/conv-123..." }

# Poll status
curl http://localhost:3001/api/v2/status/conv-123...

# Check queue stats
curl http://localhost:3001/api/v2/queue/stats
```

---

## 🧪 Testing Checklist

### Queue Setup
- [ ] Redis is running
- [ ] BullMQ connects successfully
- [ ] Worker starts and processes jobs

### Async Flow
- [ ] POST /api/v2/convert returns jobId
- [ ] GET /api/v2/status/:jobId returns status
- [ ] Completed jobs show downloadUrl
- [ ] Failed jobs show error

### Reliability
- [ ] Jobs retry on failure
- [ ] Old jobs are cleaned up
- [ ] Queue survives server restart

---

## ✅ Acceptance Criteria

| Criteria | Target | Status |
|----------|--------|--------|
| Redis connected | Yes | ⬜ |
| Worker processing | Yes | ⬜ |
| Async submit works | Yes | ⬜ |
| Status polling works | Yes | ⬜ |
| Job retry works | Yes | ⬜ |
| Queue stats available | Yes | ⬜ |

---

## 🔗 Related Files

- `docker-compose.yml` - Redis service
- `server/src/config/redis.ts` - Redis config
- `server/src/modules/conversion/conversion.queue.ts` - Queue logic
- `server/src/modules/conversion/conversion.async.route.ts` - Async routes

---

## 📚 Additional Resources

- [BullMQ Documentation](https://docs.bullmq.io/)
- [Redis Docker Hub](https://hub.docker.com/_/redis)
- [BullMQ Dashboard](https://github.com/felixmosh/bull-board)

---

## 🎉 Project Complete!

Congratulations! You have completed all tasks for the 3D File Converter optimization project.

### Summary of Achievements

| Task | Description | Status |
|------|-------------|--------|
| 01 | Docker Optimization | ⬜ |
| 02 | ODA Converter | ⬜ |
| 03 | Fastify Migration | ⬜ |
| 04 | Hybrid Conversion | ⬜ |
| 05 | Production Safeguards | ⬜ |
| 06 | Job Queue (Optional) | ⬜ |

### Final Checklist

- [ ] Docker image < 600MB
- [ ] All format conversions working
- [ ] Security (spawn instead of exec)
- [ ] Concurrency limits (p-limit)
- [ ] Health checks
- [ ] Graceful shutdown
- [ ] Cleanup jobs
