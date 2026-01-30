/**
 * Server Entry Point
 */

import config from './config/env';
import { buildApp, stopCleanup } from './app';

async function start() {
  try {
    const app = await buildApp();

    await app.listen({
      port: config.port,
      host: '0.0.0.0',
    });

    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                  3D File Converter Server                         ║
╠══════════════════════════════════════════════════════════════════╣
║  Status:    RUNNING                                               ║
║  Port:      ${String(config.port).padEnd(52)}║
║  Env:       ${config.nodeEnv.padEnd(52)}║
║  Endpoints:                                                       ║
║    - GET  /health           Health check                          ║
║    - GET  /ready            Readiness probe                       ║
║    - GET  /info             Server info                           ║
║    - GET  /api/formats      Supported formats                     ║
║    - POST /api/convert      Convert 3D file                       ║
║    - GET  /api/download/:f  Download converted file               ║
║    - POST /api/cleanup      Trigger manual cleanup                ║
╚══════════════════════════════════════════════════════════════════╝
`);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n[Server] ${signal} received, shutting down gracefully...`);
      
      stopCleanup();
      
      await app.close();
      console.log('[Server] Closed all connections');
      
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();
