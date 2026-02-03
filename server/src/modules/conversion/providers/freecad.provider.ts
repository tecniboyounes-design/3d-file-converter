/**
 * FreeCAD Provider - Handles CAD files with ACIS 3D solids
 * 
 * FreeCAD uses OpenCASCADE which can process DXF/STEP/IGES files
 * containing 3D solid geometry that Blender cannot import.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { ConversionError } from '../../../common/errors';
import config from '../../../config/env';
import pLimit from 'p-limit';

// FreeCAD is resource-intensive, limit concurrency
const freecadLimit = pLimit(config.maxConcurrentBlender);

// Supported input formats (CAD formats with potential 3D solids)
export const FREECAD_INPUT_FORMATS = ['dxf', 'step', 'stp', 'iges', 'igs', 'brep'];

// Output formats FreeCAD can export to (mesh formats)
export const FREECAD_OUTPUT_FORMATS = ['stl', 'obj', 'ply'];

interface FreecadResult {
  outputPath: string;
  duration: number;
}

/**
 * Convert CAD file to mesh format using FreeCAD
 */
export async function convertWithFreecad(
  inputPath: string,
  outputFormat: string
): Promise<FreecadResult> {
  return freecadLimit(async () => {
    const startTime = Date.now();
    
    // Determine output path
    const inputDir = path.dirname(inputPath);
    const inputBasename = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(inputDir, `${inputBasename}.${outputFormat}`);
    
    const inputFormat = path.extname(inputPath).slice(1).toLowerCase();
    
    console.log(`[FreeCAD] Converting ${inputFormat} → ${outputFormat}`);
    console.log(`[FreeCAD] Input: ${inputPath}`);
    console.log(`[FreeCAD] Output: ${outputPath}`);
    
    await runFreecad(inputPath, outputPath, inputFormat, outputFormat);
    
    // Verify output exists
    if (!await fs.pathExists(outputPath)) {
      throw new ConversionError('FreeCAD conversion produced no output file');
    }
    
    const stats = await fs.stat(outputPath);
    if (stats.size === 0) {
      throw new ConversionError('FreeCAD conversion produced empty output file');
    }
    
    const duration = Date.now() - startTime;
    console.log(`[FreeCAD] Conversion successful in ${duration}ms`);
    
    return { outputPath, duration };
  });
}

/**
 * Run FreeCAD conversion process
 */
async function runFreecad(
  inputPath: string,
  outputPath: string,
  inputFormat: string,
  outputFormat: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve('/usr/src/app/scripts/freecad/export.py');
    
    // FreeCAD command-line mode
    const args = [scriptPath];
    
    const env = {
      ...process.env,
      INPUT_FILE_PATH: inputPath,
      OUTPUT_FILE_PATH: outputPath,
      INPUT_FILE_FORMAT: inputFormat,
      OUTPUT_FILE_FORMAT: outputFormat,
    };
    
    console.log(`[FreeCAD] Running: freecad-convert ${args.join(' ')}`);
    
    // Use wrapper script that runs with xvfb
    const proc = spawn('freecad-convert', args, {
      env,
      timeout: config.conversionTimeout,
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      // Log FreeCAD output in real-time
      output.split('\n').filter(Boolean).forEach((line: string) => {
        console.log(`[FreeCAD] ${line}`);
      });
    });
    
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (error) => {
      console.error(`[FreeCAD] Process error: ${error.message}`);
      reject(new ConversionError(`FreeCAD process error: ${error.message}`));
    });
    
    proc.on('close', (code) => {
      console.log(`[FreeCAD] Exit code: ${code}`);
      
      if (stderr) {
        console.log(`[FreeCAD] stderr: ${stderr}`);
      }
      
      if (code !== 0) {
        reject(new ConversionError(
          `FreeCAD conversion failed with exit code ${code}`,
          stderr || stdout
        ));
        return;
      }
      
      resolve();
    });
  });
}

/**
 * Check if FreeCAD can handle this input format
 */
export function canFreecadHandle(inputFormat: string): boolean {
  return FREECAD_INPUT_FORMATS.includes(inputFormat.toLowerCase());
}

/**
 * Check if FreeCAD can export to this format
 */
export function canFreecadExport(outputFormat: string): boolean {
  return FREECAD_OUTPUT_FORMATS.includes(outputFormat.toLowerCase());
}
