/**
 * IfcOpenShell Provider - Handles IFC format conversions
 * 
 * Uses IfcConvert CLI for reading IFC files (IFC → OBJ/GLB/DAE/STEP/etc.)
 * Uses mesh_to_ifc.py Python script for writing IFC files (OBJ → IFC)
 * 
 * Multi-object preservation: When converting to IFC, each OBJ group becomes
 * a separate IfcBuildingElementProxy that users can select/edit in BIM software.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import { ConversionError, TimeoutError } from '../../../common/errors';
import config from '../../../config/env';
import pLimit from 'p-limit';

// Limit concurrent IfcConvert processes (similar weight to Blender)
const ifcLimit = pLimit(config.maxConcurrentBlender);

/**
 * Formats that IfcConvert can export to directly (native support)
 */
export const IFC_CONVERT_NATIVE_FORMATS = [
  'obj', 'dae', 'glb', 'stp', 'step', 'igs', 'iges', 'svg', 'xml'
];

export interface IfcConvertOptions {
  /** Use element names instead of IDs in output (recommended for readability) */
  useElementNames?: boolean;
  /** Use GlobalId for element names (for traceability) */
  useElementGuids?: boolean;
  /** Number of parallel threads (defaults to CPU count) */
  threads?: number;
  /** Center model to origin (useful for large geo-coordinates) */
  centerModel?: boolean;
  /** Conversion timeout in ms */
  timeout?: number;
}

export interface MeshToIfcOptions {
  /** Optional JSON file with parent-child hierarchy */
  hierarchyJsonPath?: string;
  /** Conversion timeout in ms */
  timeout?: number;
}

/**
 * Check if IfcConvert binary is available
 */
export function isIfcConvertAvailable(): boolean {
  try {
    const result = require('child_process')
      .execSync('which IfcConvert 2>/dev/null || where IfcConvert 2>nul', { encoding: 'utf8' });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Convert IFC file to another format using IfcConvert CLI
 * 
 * Supported output formats: OBJ, DAE, GLB, STP, IGS, SVG, XML
 * 
 * @param inputPath - Path to input .ifc file
 * @param outputPath - Path for output file (extension determines format)
 * @param options - Conversion options
 */
export async function ifcConvert(
  inputPath: string,
  outputPath: string,
  options: IfcConvertOptions = {}
): Promise<string> {
  const { timeout = config.conversionTimeout } = options;
  
  return ifcLimit(() => executeIfcConvert(inputPath, outputPath, options, timeout));
}

async function executeIfcConvert(
  inputPath: string,
  outputPath: string,
  options: IfcConvertOptions,
  timeout: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const inputFormat = path.extname(inputPath).slice(1).toLowerCase();
    const outputFormat = path.extname(outputPath).slice(1).toLowerCase();
    
    console.log(`[IfcConvert] Converting: ${inputFormat} → ${outputFormat}`);
    console.log(`[IfcConvert] Input: ${inputPath}`);
    console.log(`[IfcConvert] Output: ${outputPath}`);
    
    // Build command arguments
    const args: string[] = [];
    
    // Multi-threading (CPU count, max 4 for stability)
    const threads = options.threads || Math.min(os.cpus().length, 4);
    args.push('-j', String(threads));
    
    // Naming options
    if (options.useElementNames) {
      args.push('--use-element-names');
    }
    if (options.useElementGuids) {
      args.push('--use-element-guids');
    }
    
    // Handle large coordinates
    if (options.centerModel) {
      args.push('--center-model');
    }
    
    // Weld vertices for cleaner mesh
    args.push('--weld-vertices');
    
    // Input and output files
    args.push(inputPath, outputPath);
    
    console.log(`[IfcConvert] Command: IfcConvert ${args.join(' ')}`);
    
    const process = spawn('IfcConvert', args);
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    // Timeout handler
    const timer = setTimeout(() => {
      killed = true;
      process.kill('SIGKILL');
      reject(new TimeoutError(`IfcConvert timed out after ${timeout}ms`));
    }, timeout);
    
    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    process.on('close', async (code) => {
      clearTimeout(timer);
      
      if (killed) return;
      
      if (code === 0 && await fs.pathExists(outputPath)) {
        const stats = await fs.stat(outputPath);
        console.log(`[IfcConvert] Success: ${stats.size} bytes`);
        resolve(outputPath);
      } else {
        const errorMsg = stderr || stdout || `Exit code: ${code}`;
        console.error(`[IfcConvert] Failed: ${errorMsg}`);
        reject(new ConversionError(
          'IfcConvert failed',
          errorMsg
        ));
      }
    });
    
    process.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[IfcConvert] Process error: ${err.message}`);
      reject(new ConversionError('IfcConvert not available', err.message));
    });
  });
}

/**
 * Convert OBJ file to IFC format using mesh_to_ifc.py script
 * 
 * Each OBJ group becomes a separate IfcBuildingElementProxy.
 * Hierarchy from colon notation (Obj.195:1 → child of Obj.195) is preserved.
 * 
 * @param inputPath - Path to input .obj file
 * @param outputPath - Path for output .ifc file
 * @param options - Conversion options
 */
export async function meshToIfc(
  inputPath: string,
  outputPath: string,
  options: MeshToIfcOptions = {}
): Promise<string> {
  const { timeout = config.conversionTimeout, hierarchyJsonPath } = options;
  
  return ifcLimit(() => executeMeshToIfc(inputPath, outputPath, hierarchyJsonPath, timeout));
}

async function executeMeshToIfc(
  inputPath: string,
  outputPath: string,
  hierarchyJsonPath: string | undefined,
  timeout: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[MeshToIFC] Converting: OBJ → IFC`);
    console.log(`[MeshToIFC] Input: ${inputPath}`);
    console.log(`[MeshToIFC] Output: ${outputPath}`);
    if (hierarchyJsonPath) {
      console.log(`[MeshToIFC] Hierarchy: ${hierarchyJsonPath}`);
    }
    
    // Path to mesh_to_ifc.py script
    const scriptPath = path.join(process.cwd(), 'scripts', 'ifcopenshell', 'mesh_to_ifc.py');
    
    // Build command arguments
    const args = [scriptPath, inputPath, outputPath];
    if (hierarchyJsonPath && fs.existsSync(hierarchyJsonPath)) {
      args.push(hierarchyJsonPath);
    }
    
    console.log(`[MeshToIFC] Command: python3 ${args.join(' ')}`);
    
    const process_child = spawn('python3', args);
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    // Timeout handler
    const timer = setTimeout(() => {
      killed = true;
      process_child.kill('SIGKILL');
      reject(new TimeoutError(`MeshToIFC timed out after ${timeout}ms`));
    }, timeout);
    
    process_child.stdout.on('data', (data) => {
      const msg = data.toString();
      stdout += msg;
      // Log progress messages
      msg.split('\n').filter(Boolean).forEach((line: string) => {
        console.log(`[MeshToIFC] ${line}`);
      });
    });
    
    process_child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    process_child.on('close', async (code) => {
      clearTimeout(timer);
      
      if (killed) return;
      
      if (code === 0 && await fs.pathExists(outputPath)) {
        const stats = await fs.stat(outputPath);
        console.log(`[MeshToIFC] Success: ${stats.size} bytes`);
        resolve(outputPath);
      } else {
        const errorMsg = stderr || stdout || `Exit code: ${code}`;
        console.error(`[MeshToIFC] Failed: ${errorMsg}`);
        reject(new ConversionError(
          'Mesh to IFC conversion failed',
          errorMsg
        ));
      }
    });
    
    process_child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[MeshToIFC] Process error: ${err.message}`);
      reject(new ConversionError('Python not available for mesh_to_ifc.py', err.message));
    });
  });
}
