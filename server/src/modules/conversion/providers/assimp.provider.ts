/**
 * Assimp Provider - Fast lightweight 3D conversions
 * 
 * SECURITY: Uses spawn() instead of exec() to prevent command injection
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
 * 
 * @param inputPath - Absolute path to input file
 * @param outputPath - Absolute path for output file
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
  console.log(`[Assimp] Input: ${inputPath}`);
  console.log(`[Assimp] Output: ${outputPath}`);

  return new Promise((resolve, reject) => {
    // ✅ SECURE: Using spawn with arguments array (no shell injection possible)
    const proc = spawn('assimp', [
      'export',
      inputPath,
      outputPath
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new ConversionError(`Assimp process error: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[Assimp] Exit code: ${code}`);
        console.error(`[Assimp] stderr: ${stderr}`);
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

/**
 * Get Assimp version string
 */
export async function getAssimpVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('assimp', ['version']);
    let output = '';
    
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim().split('\n')[0] || 'unknown');
      } else {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}
