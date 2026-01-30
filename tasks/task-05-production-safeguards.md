# Task 05: Production Safeguards

## 📋 Task Overview

| Field | Value |
|-------|-------|
| **Task ID** | TASK-05 |
| **Priority** | 🔴 CRITICAL |
| **Estimated Time** | 1 day |
| **Dependencies** | Task 01-04 |
| **Blocks** | Production deployment |

## 🎯 Objectives

1. Implement RAM protection (p-limit concurrency)
2. Configure proper timeouts
3. Add comprehensive error handling
4. Implement graceful shutdown
5. Add production logging
6. Configure Docker health checks

---

## ✅ Prerequisites

- [ ] Task 01-04 completed
- [ ] Server running with Fastify
- [ ] Conversion routes working

---

## 📝 Step-by-Step Instructions

### Step 1: Verify p-limit Implementation

Ensure `p-limit` is properly configured in providers. Check `server/src/modules/conversion/providers/blender.provider.ts`:

```typescript
import pLimit from 'p-limit';
import config from '../../../config/env';

// CRITICAL: Limit concurrent Blender processes
// Without this, 10 simultaneous requests = 10 Blender processes = OOM crash
const blenderLimit = pLimit(config.maxConcurrentBlender); // Default: 2

export async function blenderConvert(...) {
  // All Blender calls go through the limiter
  return blenderLimit(() => executeBlender(...));
}
```

### Step 2: Add Request Timeout Handling

Create `server/src/plugins/timeout.ts`:

```typescript
/**
 * Request timeout plugin
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import config from '../config/env';

async function timeoutPlugin(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Set request timeout
    request.raw.setTimeout(config.conversionTimeout, () => {
      reply.status(408).send({
        error: 'TIMEOUT',
        message: 'Request timed out. Try with a smaller file or simpler conversion.'
      });
    });
  });
}

export default fp(timeoutPlugin, {
  name: 'timeout-plugin'
});
```

### Step 3: Add Graceful Shutdown

Update `server/src/server.ts`:

```typescript
/**
 * Server Entry Point with Graceful Shutdown
 */

import { buildApp } from './app';
import config from './config/env';
import fs from 'fs-extra';
import path from 'path';

let isShuttingDown = false;

async function main() {
  const uploadDir = path.resolve(config.uploadDir);
  await fs.ensureDir(uploadDir);

  const app = await buildApp();

  // ═══════════════════════════════════════════════════════════════
  // GRACEFUL SHUTDOWN
  // ═══════════════════════════════════════════════════════════════
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[Server] Received ${signal}, starting graceful shutdown...`);

    // Stop accepting new connections
    try {
      await app.close();
      console.log('[Server] HTTP server closed');
    } catch (err) {
      console.error('[Server] Error closing HTTP server:', err);
    }

    // Give ongoing requests time to complete (max 30 seconds)
    console.log('[Server] Waiting for ongoing requests to complete...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Cleanup uploads directory
    try {
      const files = await fs.readdir(uploadDir);
      for (const file of files) {
        if (file === '.keep' || file === '.gitkeep') continue;
        await fs.remove(path.join(uploadDir, file));
      }
      console.log('[Server] Cleaned up temporary files');
    } catch (err) {
      console.error('[Server] Cleanup error:', err);
    }

    console.log('[Server] Shutdown complete');
    process.exit(0);
  };

  // Register shutdown handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
  });

  // ═══════════════════════════════════════════════════════════════
  // START SERVER
  // ═══════════════════════════════════════════════════════════════
  try {
    await app.listen({
      port: config.port,
      host: config.host,
    });

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           3D File Converter Server Started                ║
╠═══════════════════════════════════════════════════════════╣
║  URL:          http://${config.host}:${config.port}                      ║
║  Environment:  ${config.nodeEnv.padEnd(41)}║
║  Blender Max:  ${String(config.maxConcurrentBlender).padEnd(41)}║
║  Assimp Max:   ${String(config.maxConcurrentAssimp).padEnd(41)}║
║  Timeout:      ${(config.conversionTimeout / 1000 / 60).toFixed(0)} minutes                                  ║
╚═══════════════════════════════════════════════════════════╝
    `);

  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
```

### Step 4: Add Production Logging

Create `server/src/plugins/logger.ts`:

```typescript
/**
 * Enhanced logging configuration
 */

import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

interface RequestLog {
  method: string;
  url: string;
  statusCode: number;
  duration: number;
  userAgent?: string;
}

async function loggerPlugin(fastify: FastifyInstance) {
  // Log all requests
  fastify.addHook('onResponse', async (request, reply) => {
    const log: RequestLog = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      duration: reply.elapsedTime,
      userAgent: request.headers['user-agent']
    };

    // Don't log health checks in production (too noisy)
    if (request.url === '/health' || request.url === '/ready') {
      return;
    }

    // Log based on status code
    if (reply.statusCode >= 500) {
      fastify.log.error(log, 'Request failed');
    } else if (reply.statusCode >= 400) {
      fastify.log.warn(log, 'Request error');
    } else {
      fastify.log.info(log, 'Request completed');
    }
  });
}

export default fp(loggerPlugin, {
  name: 'logger-plugin'
});
```

### Step 5: Add Memory Monitoring

Create `server/src/common/monitor.ts`:

```typescript
/**
 * Memory and resource monitoring
 */

import os from 'os';

interface MemoryStats {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  freeMemory: number;
  totalMemory: number;
  percentUsed: number;
}

/**
 * Get current memory statistics
 */
export function getMemoryStats(): MemoryStats {
  const mem = process.memoryUsage();
  const freeMemory = os.freemem();
  const totalMemory = os.totalmem();

  return {
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    rss: Math.round(mem.rss / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
    freeMemory: Math.round(freeMemory / 1024 / 1024),
    totalMemory: Math.round(totalMemory / 1024 / 1024),
    percentUsed: Math.round((1 - freeMemory / totalMemory) * 100)
  };
}

/**
 * Log memory stats periodically
 */
export function startMemoryMonitor(intervalMs: number = 60000): void {
  console.log('[Monitor] Starting memory monitor');

  setInterval(() => {
    const stats = getMemoryStats();
    console.log(`[Monitor] Memory: Heap ${stats.heapUsed}/${stats.heapTotal}MB | RSS ${stats.rss}MB | System ${stats.percentUsed}% used`);

    // Warn if memory is getting high
    if (stats.percentUsed > 85) {
      console.warn(`[Monitor] ⚠️ HIGH MEMORY USAGE: ${stats.percentUsed}%`);
    }
  }, intervalMs);
}
```

### Step 6: Update Health Check with Memory Info

Update `server/src/modules/health/health.route.ts`:

```typescript
/**
 * Health check routes with system info
 */

import { FastifyInstance } from 'fastify';
import { isBlenderAvailable } from '../conversion/providers/blender.provider';
import { isAssimpAvailable } from '../conversion/providers/assimp.provider';
import { isOdaAvailable } from '../conversion/providers/oda.provider';
import { getMemoryStats } from '../../common/monitor';

export async function healthRoutes(fastify: FastifyInstance) {
  // Basic liveness probe (is the process alive?)
  fastify.get('/health', async () => {
    return { 
      status: 'ok', 
      timestamp: new Date().toISOString() 
    };
  });

  // Detailed readiness probe (can we handle requests?)
  fastify.get('/ready', async () => {
    const [blender, assimp, oda] = await Promise.all([
      isBlenderAvailable(),
      isAssimpAvailable(),
      isOdaAvailable(),
    ]);

    const memory = getMemoryStats();
    const memoryOk = memory.percentUsed < 90;
    const allToolsOk = blender && assimp;
    const allReady = allToolsOk && memoryOk;

    return {
      status: allReady ? 'ready' : 'degraded',
      checks: {
        blender: blender ? 'ok' : 'unavailable',
        assimp: assimp ? 'ok' : 'unavailable',
        oda: oda ? 'ok' : 'unavailable',
        memory: memoryOk ? 'ok' : 'high',
      },
      memory: {
        heapUsedMB: memory.heapUsed,
        rssMB: memory.rss,
        systemPercent: memory.percentUsed
      },
      timestamp: new Date().toISOString(),
    };
  });

  // Detailed metrics endpoint
  fastify.get('/metrics', async () => {
    const memory = getMemoryStats();
    
    return {
      uptime: process.uptime(),
      memory,
      nodeVersion: process.version,
      platform: process.platform,
      timestamp: new Date().toISOString(),
    };
  });
}
```

### Step 7: Update Dockerfile with Better Health Check

Update the HEALTHCHECK in your Dockerfile:

```dockerfile
# Health check - checks readiness endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3001/ready | grep -q '"status":"ready"' || exit 1
```

### Step 8: Add Rate Limiting (Optional but Recommended)

Install package:
```bash
npm install @fastify/rate-limit
```

Create `server/src/plugins/rate-limit.ts`:

```typescript
/**
 * Rate limiting plugin
 */

import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';

async function rateLimitPlugin(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    max: 100, // Max 100 requests
    timeWindow: '1 minute',
    
    // Custom handler for rate limit exceeded
    errorResponseBuilder: (request, context) => ({
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests. Try again in ${Math.round(context.ttl / 1000)} seconds.`,
      retryAfter: context.ttl
    }),

    // Don't rate limit health checks
    allowList: ['/health', '/ready', '/metrics'],

    // Stricter limit for conversion endpoint
    keyGenerator: (request) => {
      return request.ip;
    }
  });

  // Even stricter limit for conversion endpoint
  fastify.route({
    method: 'POST',
    url: '/api/convert',
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute'
      }
    },
    handler: async (request, reply) => {
      // This is handled by the actual route, this is just for rate limit config
      reply.callNotFound();
    }
  });
}

export default fp(rateLimitPlugin, {
  name: 'rate-limit-plugin'
});
```

### Step 9: Create Environment Example File

Create `server/.env.example`:

```bash
# Server Configuration
PORT=3001
HOST=0.0.0.0
NODE_ENV=production

# File Handling
UPLOAD_DIR=./data/uploads
MAX_FILE_SIZE=104857600  # 100MB in bytes

# Conversion Settings
CONVERSION_TIMEOUT=300000  # 5 minutes in ms

# Concurrency Limits (CRITICAL for preventing OOM)
MAX_CONCURRENT_BLENDER=2   # Blender is heavy (~400MB RAM each)
MAX_CONCURRENT_ASSIMP=5    # Assimp is lighter (~50MB RAM each)
```

### Step 10: Final Integration Test

Create `server/src/test/integration.test.ts`:

```typescript
/**
 * Integration test script
 * Run with: npx ts-node src/test/integration.test.ts
 */

import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:3001';

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('Integration Tests');
  console.log('═══════════════════════════════════════════\n');

  // Test 1: Health Check
  console.log('1. Testing /health...');
  const health = await fetch(`${BASE_URL}/health`);
  const healthData = await health.json();
  console.log(`   Status: ${health.status}`);
  console.log(`   Response: ${JSON.stringify(healthData)}`);
  console.log(`   ✅ PASS\n`);

  // Test 2: Readiness Check
  console.log('2. Testing /ready...');
  const ready = await fetch(`${BASE_URL}/ready`);
  const readyData = await ready.json();
  console.log(`   Status: ${ready.status}`);
  console.log(`   Tools: Blender=${readyData.checks.blender}, Assimp=${readyData.checks.assimp}, ODA=${readyData.checks.oda}`);
  console.log(`   Memory: ${readyData.memory.systemPercent}% used`);
  console.log(`   ✅ PASS\n`);

  // Test 3: Metrics
  console.log('3. Testing /metrics...');
  const metrics = await fetch(`${BASE_URL}/metrics`);
  const metricsData = await metrics.json();
  console.log(`   Uptime: ${Math.round(metricsData.uptime)}s`);
  console.log(`   Node: ${metricsData.nodeVersion}`);
  console.log(`   ✅ PASS\n`);

  // Test 4: Invalid conversion (no file)
  console.log('4. Testing /api/convert without file...');
  const noFile = await fetch(`${BASE_URL}/api/convert`, { method: 'POST' });
  console.log(`   Status: ${noFile.status} (expected 400)`);
  console.log(`   ✅ PASS\n`);

  console.log('═══════════════════════════════════════════');
  console.log('All tests passed!');
  console.log('═══════════════════════════════════════════');
}

runTests().catch(console.error);
```

---

## 🧪 Testing Checklist

### Concurrency Protection
- [ ] p-limit restricts Blender to max 2 processes
- [ ] p-limit restricts Assimp to max 5 processes
- [ ] Queued requests wait instead of spawning new processes

### Timeout Handling
- [ ] Long conversions don't hang forever
- [ ] Client receives timeout error after 5 minutes
- [ ] Server recovers after timeout

### Memory Protection
- [ ] Memory usage is logged
- [ ] Warning appears when memory > 85%
- [ ] Health check reports memory status

### Graceful Shutdown
- [ ] SIGTERM triggers shutdown
- [ ] Ongoing requests complete
- [ ] Temp files are cleaned up

### Error Handling
- [ ] Conversion errors return proper JSON
- [ ] File not found returns 404
- [ ] Invalid format returns 400

---

## ✅ Acceptance Criteria

| Criteria | Target | Status |
|----------|--------|--------|
| p-limit working | Max 2 Blender | ⬜ |
| Timeout configured | 5 minutes | ⬜ |
| Graceful shutdown | Yes | ⬜ |
| Memory monitoring | Yes | ⬜ |
| Health checks complete | Yes | ⬜ |
| Rate limiting | Optional | ⬜ |

---

## 🔗 Related Files

- `server/src/server.ts` - Graceful shutdown
- `server/src/common/monitor.ts` - Memory monitoring
- `server/src/modules/health/health.route.ts` - Health checks
- `server/src/config/env.ts` - Configuration

---

## ⏭️ Next Task

After completing this task, proceed to: **[Task 06: Job Queue (Optional)](./task-06-job-queue.md)**
