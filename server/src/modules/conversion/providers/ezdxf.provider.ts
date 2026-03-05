/**
 * ACIS Provider - Converts DXF files with ACIS 3DSOLID entities to STEP
 *
 * Uses InventorLoader (jmplonka/InventorLoader) to parse ACIS SAB/SAT data
 * from DXF 3DSOLID entities and export to STEP format with full B-Rep fidelity.
 *
 * Pipeline: DXF → [ezdxf extract SAB] → [InventorLoader parse] → [Acis2Step export] → STEP
 *
 * Requires: FreeCAD Python environment, ezdxf, olefile
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { ConversionError } from '../../../common/errors';
import config from '../../../config/env';

/**
 * Convert DXF with ACIS 3DSOLID entities directly to STEP using InventorLoader.
 * Runs via freecad-convert wrapper (xvfb + FreeCAD Python environment).
 */
export async function acisToStep(
  inputDxfPath: string,
  outputStepPath: string
): Promise<{ outputPath: string; duration: number }> {
  const startTime = Date.now();

  console.log(`[acis] Converting ACIS 3DSOLID from DXF → STEP`);
  console.log(`[acis] Input: ${inputDxfPath}`);
  console.log(`[acis] Output: ${outputStepPath}`);

  await new Promise<void>((resolve, reject) => {
    const scriptPath = path.resolve('/usr/src/app/scripts/inventorloader/sab_to_step.py');

    // Use freecad-convert wrapper which sets up xvfb + FreeCAD Python env
    const proc = spawn('freecad-convert', [scriptPath, inputDxfPath, outputStepPath], {
      timeout: config.conversionTimeout,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      output.split('\n').filter(Boolean).forEach((line: string) => {
        console.log(`[acis] ${line}`);
      });
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      console.error(`[acis] Process error: ${error.message}`);
      reject(new ConversionError(`ACIS conversion process error: ${error.message}`));
    });

    proc.on('close', (code) => {
      console.log(`[acis] Exit code: ${code}`);
      if (stderr) {
        console.log(`[acis] stderr: ${stderr}`);
      }
      if (code !== 0) {
        reject(new ConversionError(
          `ACIS to STEP conversion failed with exit code ${code}`,
          stderr || stdout
        ));
        return;
      }
      resolve();
    });
  });

  // Verify output
  if (!await fs.pathExists(outputStepPath)) {
    throw new ConversionError('ACIS to STEP conversion produced no output file');
  }

  const stats = await fs.stat(outputStepPath);
  if (stats.size === 0) {
    throw new ConversionError('ACIS to STEP conversion produced empty output file');
  }

  const duration = Date.now() - startTime;
  console.log(`[acis] ACIS → STEP conversion successful in ${duration}ms (${stats.size} bytes)`);

  return { outputPath: outputStepPath, duration };
}
