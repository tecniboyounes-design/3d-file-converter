/**
 * Blender Provider - Handles 3D conversions using Blender CLI
 * 
 * SECURITY: Uses spawn() instead of exec() to prevent command injection
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { ConversionError, TimeoutError } from '../../../common/errors';
import { BLENDER_SCRIPT_PATH } from '../../../common/constants';
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
    const env: NodeJS.ProcessEnv = {
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
      '--python', BLENDER_SCRIPT_PATH
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

/**
 * Get Blender version string
 */
export async function getBlenderVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('blender', ['--version']);
    let output = '';
    
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        const match = output.match(/Blender\s+(\d+\.\d+\.\d+)/);
        resolve(match ? match[1] : output.trim().split('\n')[0]);
      } else {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}
