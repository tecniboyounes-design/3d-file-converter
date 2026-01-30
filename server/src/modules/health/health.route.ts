/**
 * Health check routes
 */

import { FastifyInstance } from 'fastify';
import { 
  isBlenderAvailable, 
  getBlenderVersion 
} from '../conversion/providers/blender.provider';
import { 
  isAssimpAvailable, 
  getAssimpVersion 
} from '../conversion/providers/assimp.provider';
import { 
  isOdaAvailable, 
  getOdaVersion 
} from '../conversion/providers/oda.provider';

export async function healthRoutes(fastify: FastifyInstance) {
  /**
   * GET /health - Basic health check (always returns ok if server is running)
   */
  fastify.get('/health', async () => {
    return { 
      status: 'ok', 
      timestamp: new Date().toISOString() 
    };
  });

  /**
   * GET /ready - Detailed readiness check with tool availability
   */
  fastify.get('/ready', async () => {
    const [blender, assimp, oda] = await Promise.all([
      isBlenderAvailable(),
      isAssimpAvailable(),
      isOdaAvailable(),
    ]);

    // Core tools must be available
    const isReady = blender && assimp;
    
    return {
      status: isReady ? 'ready' : 'degraded',
      checks: {
        blender: blender ? 'ok' : 'unavailable',
        assimp: assimp ? 'ok' : 'unavailable',
        oda: oda ? 'ok' : 'unavailable', // ODA is optional (only for DWG)
      },
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * GET /info - Server information and tool versions
   */
  fastify.get('/info', async () => {
    const [blenderVersion, assimpVersion, odaVersion] = await Promise.all([
      getBlenderVersion(),
      getAssimpVersion(),
      getOdaVersion(),
    ]);

    return {
      server: {
        name: '3D File Converter',
        version: '1.0.0',
        node: process.version,
        environment: process.env.NODE_ENV || 'development',
      },
      tools: {
        blender: blenderVersion || 'not available',
        assimp: assimpVersion || 'not available',
        oda: odaVersion || 'not available',
      },
      formats: {
        input: ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'],
        output: ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'],
      },
      timestamp: new Date().toISOString(),
    };
  });
}
