/**
 * ODA File Converter Provider - Handles DWG ↔ DXF conversions
 * 
 * ODA File Converter is a GUI app that requires xvfb for headless operation.
 * It works with DIRECTORIES, not individual files.
 * 
 * SECURITY: Uses spawn() instead of exec() to prevent command injection
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { ConversionError, TimeoutError } from '../../../common/errors';
import config from '../../../config/env';

// ODA CLI parameters
type OdaOutputVersion = 'ACAD9' | 'ACAD2000' | 'ACAD2010' | 'ACAD2018';
type OdaOutputType = 'DXF' | 'DWG';

interface OdaConversionOptions {
  version?: OdaOutputVersion;
  timeout?: number;
  audit?: boolean;
}

/**
 * Convert DWG ↔ DXF using ODA File Converter
 * 
 * NOTE: ODA requires DIRECTORIES as input/output, not individual files.
 * This function handles creating temporary directories for the conversion.
 * 
 * @param inputFilePath - Full path to input file (DWG or DXF)
 * @param outputFormat - 'DXF' or 'DWG'
 * @param options - Conversion options
 * @returns Path to the converted file
 */
export async function odaConvert(
  inputFilePath: string,
  outputFormat: OdaOutputType,
  options: OdaConversionOptions = {}
): Promise<string> {
  const { 
    version = 'ACAD2018', 
    timeout = config.conversionTimeout,
    audit = true 
  } = options;

  // Validate input
  const inputExt = path.extname(inputFilePath).toLowerCase();
  if (!['.dwg', '.dxf'].includes(inputExt)) {
    throw new ConversionError(`ODA only supports DWG and DXF files. Got: ${inputExt}`);
  }

  if (!['DXF', 'DWG'].includes(outputFormat.toUpperCase())) {
    throw new ConversionError(`ODA output format must be DXF or DWG. Got: ${outputFormat}`);
  }

  const inputDir = path.dirname(inputFilePath);
  const inputFileName = path.basename(inputFilePath);
  const outputFileName = inputFileName.replace(inputExt, `.${outputFormat.toLowerCase()}`);

  // Create temporary directories (ODA requires directories, not files)
  const timestamp = Date.now();
  const tempInputDir = path.join(inputDir, `oda_input_${timestamp}`);
  const tempOutputDir = path.join(inputDir, `oda_output_${timestamp}`);

  try {
    // Setup temp directories
    await fs.ensureDir(tempInputDir);
    await fs.ensureDir(tempOutputDir);
    await fs.copy(inputFilePath, path.join(tempInputDir, inputFileName));

    console.log(`[ODA] Converting ${inputFileName} to ${outputFormat}`);
    console.log(`[ODA] Input dir: ${tempInputDir}`);
    console.log(`[ODA] Output dir: ${tempOutputDir}`);

    // Execute ODA with xvfb-run for headless operation
    await executeOda(
      tempInputDir,
      tempOutputDir,
      version,
      outputFormat.toUpperCase() as OdaOutputType,
      audit,
      timeout
    );

    // Find and move the output file
    const outputFilePath = path.join(tempOutputDir, outputFileName);
    
    if (await fs.pathExists(outputFilePath)) {
      // Move output file to original input directory
      const finalOutputPath = path.join(inputDir, outputFileName);
      await fs.move(outputFilePath, finalOutputPath, { overwrite: true });
      
      console.log(`[ODA] Conversion successful: ${finalOutputPath}`);
      return finalOutputPath;
    } else {
      // List what files were created (for debugging)
      const files = await fs.readdir(tempOutputDir).catch(() => []);
      console.error(`[ODA] Expected ${outputFileName}, found: ${files.join(', ') || 'nothing'}`);
      throw new ConversionError(
        `ODA conversion completed but output file not found. Expected: ${outputFileName}`
      );
    }
  } finally {
    // Always cleanup temp directories
    await fs.remove(tempInputDir).catch(() => {});
    await fs.remove(tempOutputDir).catch(() => {});
  }
}

/**
 * Execute ODA File Converter with xvfb-run
 */
async function executeOda(
  inputDir: string,
  outputDir: string,
  version: OdaOutputVersion,
  outputType: OdaOutputType,
  audit: boolean,
  timeout: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Set up environment for Qt (ODA uses Qt)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_RUNTIME_DIR: '/tmp/runtime-root',
    };

    // Ensure runtime dir exists with correct permissions
    fs.ensureDirSync('/tmp/runtime-root', { mode: 0o700 });

    // ✅ SECURE: Using spawn with arguments array (no shell injection possible)
    // xvfb-run provides a virtual X display for ODA's Qt GUI
    const proc = spawn('xvfb-run', [
      '-a',  // Auto-select display number
      '/usr/bin/ODAFileConverter',
      inputDir,         // Input folder
      outputDir,        // Output folder
      version,          // Output version (ACAD2018, etc.)
      outputType,       // DXF or DWG
      '0',              // Recurse input folder: 0 = no
      audit ? '1' : '0' // Audit: 1 = yes (fix errors)
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
      reject(new TimeoutError(`ODA conversion timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new ConversionError(`ODA process error: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);

      if (killed) return; // Already rejected due to timeout

      if (code !== 0) {
        console.error(`[ODA] Exit code: ${code}`);
        console.error(`[ODA] stderr: ${stderr}`);
        reject(new ConversionError(
          `ODA conversion failed with exit code ${code}`,
          stderr
        ));
        return;
      }

      console.log(`[ODA] Process completed successfully`);
      resolve();
    });
  });
}

/**
 * Convert DWG to DXF (convenience wrapper)
 */
export async function dwgToDxf(
  dwgPath: string, 
  options?: OdaConversionOptions
): Promise<string> {
  return odaConvert(dwgPath, 'DXF', options);
}

/**
 * Convert DXF to DWG (convenience wrapper)
 */
export async function dxfToDwg(
  dxfPath: string, 
  options?: OdaConversionOptions
): Promise<string> {
  return odaConvert(dxfPath, 'DWG', options);
}

/**
 * Check if ODA File Converter is available
 */
export async function isOdaAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['ODAFileConverter']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Get ODA version (from dpkg)
 */
export async function getOdaVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('dpkg', ['-l', 'odafileconverter']);
    let output = '';
    
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        const match = output.match(/odafileconverter\s+(\S+)/);
        resolve(match ? match[1] : 'installed');
      } else {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}
