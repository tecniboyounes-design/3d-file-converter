/**
 * Conversion Service - Smart routing between conversion tools
 * 
 * Decision Matrix:
 * 
 * 1. DXF ↔ DWG: Use ODA File Converter (direct format swap)
 * 
 * 2. Any format → DWG: Convert to DXF first (Blender), then DXF → DWG (ODA)
 * 
 * 3. DWG/DXF INPUT → Any format: ODA (DWG→DXF) + InventorLoader/Blender/FreeCAD
 * 
 * 4. Any format → DXF: Use Blender directly
 * 
 * 5. STEP/IGES Routing (FreeCAD-based):
 *    - STEP/IGES → STEP/IGES: FreeCAD direct CAD-to-CAD
 *    - STEP/IGES → DXF: FreeCAD direct export
 *    - STEP/IGES → DWG: FreeCAD → DXF → ODA
 *    - STEP/IGES → Mesh: FreeCAD → STL → Blender/Assimp
 *    - Any → STEP/IGES: Blender → STL → FreeCAD (solidification)
 * 
 * 6. IFC Routing (IfcOpenShell-based):
 *    - IFC → Mesh/CAD: IfcConvert direct (OBJ/GLB/DAE/STEP/IGES)
 *    - Any → IFC: Blender → OBJ → mesh_to_ifc.py (multi-object preservation)
 * 
 * 7. Simple Mesh → Simple Mesh: Assimp → Blender → FreeCAD (fallback chain)
 *
 * 8. CAD formats: Blender → FreeCAD (fallback chain)
 * 
 * 9. Fallback: Try full chain for any other formats
 * 
 * This allows converting ANY format to ANY format with maximum compatibility.
 */

import path from 'path';
import fs from 'fs-extra';
import { readFileSync } from 'fs';
import {
  blenderConvert,
  assimpConvert,
  odaConvert,
  dwgToDxf,
  convertWithFreecad,
  canFreecadHandle,
  canFreecadExportCad,
  convertMeshToStep,
  convertCadToCad,
  ifcConvert,
  meshToIfc,
  isIfcConvertAvailable,
  IFC_CONVERT_NATIVE_FORMATS,
  acisToStep
} from './providers';
import { 
  isSimpleMesh, 
  isCadFormat, 
  isDwgFormat, 
  isDxfFile,
  isStepFormat,
  isIgesFormat,
  isBrepCadFormat,
  getExtension,
  generateOutputFilename 
} from '../../common/utils';
import { 
  ConversionError, 
  UnsupportedFormatError 
} from '../../common/errors';
import { logConversionError } from '../../common/errorLogger';
import { 
  isSupportedInputFormat, 
  isSupportedOutputFormat,
  isIfcFormat
} from '../../common/constants';

interface ConversionResult {
  outputPath: string;
  tool: 'assimp' | 'blender' | 'oda' | 'pipeline' | 'ifcopenshell';
  duration: number;
}

/**
 * Check if an OBJ file contains colon-notation groups (e.g., "g Obj.195:1")
 * These indicate parent-child relationships that Blender can preserve
 */
function objHasColonNotationGroups(objFilePath: string): boolean {
  try {
    // Read first 50KB of the file to check for colon notation
    const buffer = Buffer.alloc(50 * 1024);
    const fd = require('fs').openSync(objFilePath, 'r');
    const bytesRead = require('fs').readSync(fd, buffer, 0, buffer.length, 0);
    require('fs').closeSync(fd);
    
    const content = buffer.toString('utf8', 0, bytesRead);
    // Check for patterns like "g Obj.123:1" or "g ComponentName_123:1"
    const colonPattern = /^g\s+\S+:\d+$/m;
    const hasColonNotation = colonPattern.test(content);
    
    if (hasColonNotation) {
      log(`OBJ file has colon-notation groups (e.g., Obj.XXX:1) - prefer Blender for hierarchy`);
    }
    
    return hasColonNotation;
  } catch (err) {
    // If we can't read the file, assume no special notation
    return false;
  }
}

// =====================================================
// LOGGING HELPER
// =====================================================
function log(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
  const prefix = '[Conversion]';
  const icons = {
    info: '→',
    success: '✓',
    error: '✗',
    warn: '⚠'
  };
  console.log(`${prefix} ${icons[type]} ${message}`);
}

/**
 * Convert a 3D file to the target format
 * 
 * This function implements the "Assimp First, Blender Fallback" strategy
 * with special handling for DWG files via ODA.
 * 
 * Tracks conversion steps and logs errors to data/errorLogs on failure.
 */
export async function convertFile(
  inputPath: string,
  outputFormat: string
): Promise<ConversionResult> {
  const startTime = Date.now();
  const inputFormat = getExtension(inputPath);
  const normalizedOutputFormat = outputFormat.toLowerCase();
  const inputFilename = path.basename(inputPath);

  // Step tracking for error logging
  const stepsCompleted: string[] = [];
  let currentRoute = '';
  let currentStep = '';

  try {

  log(`Starting conversion: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`);
  log(`Input file: ${inputFilename}`);

  // Validate formats
  if (!isSupportedInputFormat(inputFormat)) {
    log(`Unsupported input format: ${inputFormat}`, 'error');
    throw new UnsupportedFormatError(inputFormat);
  }
  if (!isSupportedOutputFormat(normalizedOutputFormat)) {
    log(`Unsupported output format: ${normalizedOutputFormat}`, 'error');
    throw new UnsupportedFormatError(normalizedOutputFormat);
  }

  // Generate output path
  const inputDir = path.dirname(inputPath);
  const outputFilename = generateOutputFilename(path.basename(inputPath), normalizedOutputFormat);
  const outputPath = path.join(inputDir, outputFilename);

  // Same format - just copy
  if (inputFormat === normalizedOutputFormat) {
    log(`Same format detected, copying file...`);
    await fs.copy(inputPath, outputPath);
    log(`Copy complete`, 'success');
    return {
      outputPath,
      tool: 'assimp', // No conversion needed
      duration: Date.now() - startTime
    };
  }

  let tool: ConversionResult['tool'];

  // =====================================================
  // 1. DXF ↔ DWG (Use ODA - direct format swap)
  // =====================================================
  if ((inputFormat === 'dxf' && normalizedOutputFormat === 'dwg') ||
      (inputFormat === 'dwg' && normalizedOutputFormat === 'dxf')) {
    currentRoute = 'DXF ↔ DWG swap (ODA)';
    log(`Route: DXF ↔ DWG swap`);
    log(`Trying ODA File Converter...`);
    const odaOutputFormat = normalizedOutputFormat.toUpperCase() as 'DXF' | 'DWG';
    try {
      currentStep = `ODA: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`;
      const odaOutputPath = await odaConvert(inputPath, odaOutputFormat);
      stepsCompleted.push(`ODA: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`);
      log(`ODA conversion successful`, 'success');
      // Move ODA output to expected output path if different
      if (odaOutputPath !== outputPath) {
        await fs.move(odaOutputPath, outputPath, { overwrite: true });
      }
      return {
        outputPath,
        tool: 'oda',
        duration: Date.now() - startTime
      };
    } catch (odaErr) {
      log(`ODA conversion failed: ${odaErr instanceof Error ? odaErr.message : String(odaErr)}`, 'error');
      throw new ConversionError(
        `Failed to convert ${inputFormat.toUpperCase()} to ${normalizedOutputFormat.toUpperCase()}`,
        `ODA File Converter failed. Error: ${odaErr instanceof Error ? odaErr.message : String(odaErr)}`
      );
    }
  }

  // =====================================================
  // 2. Any format → DWG (via DXF intermediate using Blender + ODA)
  //    Skip STEP/IGES (handled by Route 5a) and IFC (handled by Route 6a)
  // =====================================================
  if (normalizedOutputFormat === 'dwg' && inputFormat !== 'dxf'
      && !isBrepCadFormat(inputFormat) && !isIfcFormat(inputFormat)) {
    currentRoute = `Any → DWG (via DXF intermediate)`;
    log(`Route: Any → DWG (via DXF intermediate)`);
    const tempDxfPath = path.join(inputDir, `temp_${Date.now()}.dxf`);
    
    try {
      // Step 1: Convert to DXF via Blender (fallback: Assimp → OBJ → Blender → DXF)
      currentStep = `Blender: ${inputFormat.toUpperCase()} → DXF`;
      log(`Step 1: Trying Blender (${inputFormat.toUpperCase()} → DXF)...`);
      try {
        await blenderConvert(inputPath, tempDxfPath);
      } catch (blenderErr) {
        // Blender failed (e.g., can't import 3DS), try via intermediate OBJ
        log(`Blender failed, trying via intermediate OBJ...`, 'warn');
        const tempObjPath = path.join(inputDir, `temp_obj_${Date.now()}.obj`);
        try {
          await assimpConvert(inputPath, tempObjPath);
          await blenderConvert(tempObjPath, tempDxfPath);
        } finally {
          await fs.remove(tempObjPath).catch(() => {});
        }
      }
      stepsCompleted.push(`${inputFormat.toUpperCase()} → DXF`);
      log(`Step 1: Conversion to DXF successful`, 'success');
      
      // Step 2: Convert DXF to DWG via ODA
      currentStep = 'ODA: DXF → DWG';
      log(`Step 2: Trying ODA (DXF → DWG)...`);
      const odaOutputPath = await odaConvert(tempDxfPath, 'DWG');
      stepsCompleted.push('ODA: DXF → DWG');
      log(`Step 2: ODA conversion successful`, 'success');
      
      // Move ODA output to expected output path
      if (odaOutputPath !== outputPath) {
        await fs.move(odaOutputPath, outputPath, { overwrite: true });
      }
      
      log(`Pipeline complete: ${inputFormat.toUpperCase()} → DXF → DWG`, 'success');
      return {
        outputPath,
        tool: 'pipeline', // Blender + ODA
        duration: Date.now() - startTime
      };
    } catch (err) {
      log(`Pipeline failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      throw new ConversionError(
        `Failed to convert ${inputFormat.toUpperCase()} to DWG`,
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      await fs.remove(tempDxfPath).catch(() => {});
    }
  }

  // =====================================================
  // 3. DWG/DXF INPUT → Any format (ODA + InventorLoader/Blender/FreeCAD)
  // =====================================================
  const inputIsDwgDxf = isDwgFormat(inputFormat) || inputFormat === 'dxf';

  if (inputIsDwgDxf) {
    currentRoute = `DWG/DXF input → ${normalizedOutputFormat.toUpperCase()}`;
    log(`Route: DWG/DXF input → ${normalizedOutputFormat.toUpperCase()} output`);

    const outFmt = normalizedOutputFormat as string;
    const tempDxfPath = path.join(inputDir, `temp_oda_${Date.now()}.dxf`);

    try {
      // Step 1: DWG → DXF via ODA (skip if input is already DXF)
      let dxfPath = inputPath;
      if (isDwgFormat(inputFormat)) {
        currentStep = 'ODA: DWG → DXF';
        log(`Step 1: ODA (DWG → DXF)...`);
        const odaResult = await dwgToDxf(inputPath);
        await fs.move(odaResult, tempDxfPath, { overwrite: true });
        dxfPath = tempDxfPath;
        stepsCompleted.push('ODA: DWG → DXF');
        log(`Step 1: ODA conversion successful`, 'success');
      }

      // Step 2: Route DXF → target format
      if (isIfcFormat(outFmt)) {
        // DXF → OBJ → IFC pipeline
        const tempObjPath = path.join(inputDir, `temp_obj_${Date.now()}.obj`);
        try {
          currentStep = 'Blender: DXF → OBJ';
          log(`Step 2: DXF → OBJ via Blender...`);
          await blenderConvert(dxfPath, tempObjPath);
          stepsCompleted.push('Blender: DXF → OBJ');
          log(`Step 2 complete`, 'success');

          currentStep = 'mesh_to_ifc: OBJ → IFC';
          log(`Step 3: OBJ → IFC via mesh_to_ifc...`);
          await meshToIfc(tempObjPath, outputPath);
          stepsCompleted.push('mesh_to_ifc: OBJ → IFC');
          log(`Step 3 complete`, 'success');
        } finally {
          await fs.remove(tempObjPath).catch(() => {});
        }
      } else if (isStepFormat(outFmt) || isIgesFormat(outFmt)) {
        // Strategy A: InventorLoader ACIS extraction (DXF → STEP with full B-Rep fidelity)
        let acisSuccess = false;
        if (isStepFormat(outFmt)) {
          try {
            currentStep = 'InventorLoader: DXF → STEP (ACIS 3DSOLID)';
            log(`Step 2a: InventorLoader ACIS extraction (DXF → STEP)...`);
            await acisToStep(dxfPath, outputPath);
            stepsCompleted.push('InventorLoader: DXF → STEP (ACIS)');
            log(`Step 2a: InventorLoader ACIS → STEP successful`, 'success');
            acisSuccess = true;
          } catch (acisErr) {
            const msg = acisErr instanceof Error ? acisErr.message : String(acisErr);
            log(`Step 2a: InventorLoader failed (${msg}), trying Blender fallback...`, 'warn');
          }
        }

        // Strategy B: Blender DXF → STL → FreeCAD solidification (fallback)
        if (!acisSuccess) {
          const tempStlPath = path.join(inputDir, `temp_stl_${Date.now()}.stl`);
          try {
            currentStep = 'Blender: DXF → STL (decimated)';
            log(`Step 2b: Blender (DXF → decimated STL)...`);
            await blenderConvert(dxfPath, tempStlPath, { decimateTargetFaces: 20000 });
            stepsCompleted.push('Blender: DXF → STL (decimated)');
            log(`Step 2b: Blender successful`, 'success');

            currentStep = `FreeCAD: STL → ${outFmt.toUpperCase()}`;
            log(`Step 3: FreeCAD (STL → ${outFmt.toUpperCase()})...`);
            await convertMeshToStep(tempStlPath, outputPath);
            stepsCompleted.push(`FreeCAD: STL → ${outFmt.toUpperCase()}`);
            log(`Step 3: FreeCAD solidification successful`, 'success');
          } finally {
            await fs.remove(tempStlPath).catch(() => {});
          }
        }
      } else {
        // DXF → target mesh format via Blender/Assimp fallback chain
        currentStep = `Fallback: DXF → ${outFmt.toUpperCase()}`;
        log(`Step 2: DXF → ${outFmt.toUpperCase()} via fallback chain...`);
        await convertWithFullFallback(dxfPath, outputPath);
        stepsCompleted.push(`Fallback: DXF → ${outFmt.toUpperCase()}`);
        log(`Step 2: Conversion successful`, 'success');
      }

      log(`Pipeline complete`, 'success');
      return {
        outputPath,
        tool: 'pipeline',
        duration: Date.now() - startTime
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`Pipeline failed: ${error}`, 'error');
      throw new ConversionError(
        `Failed to convert ${inputFormat.toUpperCase()} to ${normalizedOutputFormat.toUpperCase()}`,
        `ODA pipeline failed: ${error}`
      );
    } finally {
      await fs.remove(tempDxfPath).catch(() => {});
    }
  }

  // =====================================================
  // 4. Any format → DXF (Use Blender)
  //    Skip STEP/IGES (handled by Route 5a) and IFC (handled by Route 6a)
  // =====================================================
  if (normalizedOutputFormat === 'dxf'
      && !isBrepCadFormat(inputFormat) && !isIfcFormat(inputFormat)) {
    currentRoute = `Any → DXF (Blender)`;
    log(`Route: Any → DXF`);
    log(`Trying Blender...`);
    try {
      currentStep = `Blender: ${inputFormat.toUpperCase()} → DXF`;
      await blenderConvert(inputPath, outputPath);
      stepsCompleted.push(`Blender: ${inputFormat.toUpperCase()} → DXF`);
      log(`Blender conversion successful`, 'success');
      return {
        outputPath,
        tool: 'blender',
        duration: Date.now() - startTime
      };
    } catch (blenderErr) {
      log(`Blender direct failed, trying via intermediate OBJ...`, 'warn');
      // Blender failed (e.g., can't import 3DS), try via Assimp → OBJ → Blender → DXF
      if (isSimpleMesh(inputFormat)) {
        const tempObjPath = path.join(inputDir, `temp_obj_${Date.now()}.obj`);
        try {
          await assimpConvert(inputPath, tempObjPath);
          await blenderConvert(tempObjPath, outputPath);
          stepsCompleted.push(`Assimp: ${inputFormat.toUpperCase()} → OBJ, Blender: OBJ → DXF`);
          log(`Intermediate OBJ conversion successful`, 'success');
          return {
            outputPath,
            tool: 'pipeline',
            duration: Date.now() - startTime
          };
        } catch (fallbackErr) {
          // Both direct and intermediate failed
        } finally {
          await fs.remove(tempObjPath).catch(() => {});
        }
      }
      throw new ConversionError(
        `Failed to convert ${inputFormat.toUpperCase()} to DXF`,
        `Blender could not export to DXF. Error: ${blenderErr instanceof Error ? blenderErr.message : String(blenderErr)}`
      );
    }
  }

  // =====================================================
  // 5. STEP/STP/IGES ROUTING (FreeCAD-based)
  // =====================================================
  const isStepOutput = isStepFormat(normalizedOutputFormat);
  const isIgesOutput = isIgesFormat(normalizedOutputFormat);
  const isStepInput = isStepFormat(inputFormat);
  const isIgesInput = isIgesFormat(inputFormat);
  
  // 5a. STEP/IGES INPUT → Any format
  if (isStepInput || isIgesInput) {
    currentRoute = `STEP/IGES input → ${normalizedOutputFormat.toUpperCase()}`;
    log(`Route: STEP/IGES input → ${normalizedOutputFormat.toUpperCase()}`);
    
    // STEP/IGES → STEP/IGES (CAD-to-CAD via FreeCAD)
    if (isStepOutput || isIgesOutput) {
      log(`CAD-to-CAD conversion: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`);
      try {
        currentStep = `FreeCAD CAD-to-CAD: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`;
        await convertCadToCad(inputPath, outputPath);
        stepsCompleted.push(`FreeCAD CAD-to-CAD: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`);
        log(`CAD-to-CAD conversion successful`, 'success');
        return {
          outputPath,
          tool: 'pipeline',
          duration: Date.now() - startTime
        };
      } catch (err) {
        log(`CAD-to-CAD conversion failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        throw new ConversionError(
          `Failed to convert ${inputFormat.toUpperCase()} to ${normalizedOutputFormat.toUpperCase()}`,
          `FreeCAD CAD-to-CAD conversion failed. Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    
    // STEP/IGES → DXF (FreeCAD direct)
    if ((normalizedOutputFormat as string) === 'dxf') {
      log(`STEP/IGES → DXF via FreeCAD...`);
      try {
        currentStep = `FreeCAD: ${inputFormat.toUpperCase()} → DXF`;
        await convertCadToCad(inputPath, outputPath);
        stepsCompleted.push(`FreeCAD: ${inputFormat.toUpperCase()} → DXF`);
        log(`STEP/IGES → DXF successful`, 'success');
        return {
          outputPath,
          tool: 'pipeline',
          duration: Date.now() - startTime
        };
      } catch (err) {
        log(`FreeCAD DXF export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        throw new ConversionError(
          `Failed to convert ${inputFormat.toUpperCase()} to DXF`,
          `FreeCAD could not export to DXF. Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    
    // STEP/IGES → DWG (FreeCAD → DXF → ODA)
    if (normalizedOutputFormat === 'dwg') {
      log(`STEP/IGES → DWG via FreeCAD + ODA...`);
      const tempDxfPath = path.join(inputDir, `temp_${Date.now()}.dxf`);
      try {
        // Step 1: STEP/IGES → DXF via FreeCAD
        currentStep = `FreeCAD: ${inputFormat.toUpperCase()} → DXF`;
        log(`Step 1: ${inputFormat.toUpperCase()} → DXF via FreeCAD...`);
        await convertCadToCad(inputPath, tempDxfPath);
        stepsCompleted.push(`FreeCAD: ${inputFormat.toUpperCase()} → DXF`);
        log(`Step 1 complete`, 'success');
        
        // Step 2: DXF → DWG via ODA
        currentStep = 'ODA: DXF → DWG';
        log(`Step 2: DXF → DWG via ODA...`);
        const odaOutputPath = await odaConvert(tempDxfPath, 'DWG');
        stepsCompleted.push('ODA: DXF → DWG');
        if (odaOutputPath !== outputPath) {
          await fs.move(odaOutputPath, outputPath, { overwrite: true });
        }
        log(`Step 2 complete`, 'success');
        
        return {
          outputPath,
          tool: 'pipeline',
          duration: Date.now() - startTime
        };
      } catch (err) {
        log(`STEP/IGES → DWG failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        throw new ConversionError(
          `Failed to convert ${inputFormat.toUpperCase()} to DWG`,
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        await fs.remove(tempDxfPath).catch(() => {});
      }
    }
    
    // STEP/IGES → IFC (FreeCAD → STL → OBJ → mesh_to_ifc)
    if (isIfcFormat(normalizedOutputFormat)) {
      log(`STEP/IGES → IFC via FreeCAD + mesh_to_ifc...`);
      const tempStlPath = path.join(inputDir, `temp_stl_${Date.now()}.stl`);
      const tempObjPath = path.join(inputDir, `temp_obj_${Date.now()}.obj`);
      try {
        currentStep = `FreeCAD: ${inputFormat.toUpperCase()} → STL`;
        log(`Step 1: ${inputFormat.toUpperCase()} → STL via FreeCAD...`);
        const freecadResult = await convertWithFreecad(inputPath, 'stl');
        await fs.move(freecadResult.outputPath, tempStlPath, { overwrite: true });
        stepsCompleted.push(`FreeCAD: ${inputFormat.toUpperCase()} → STL`);
        log(`Step 1 complete`, 'success');

        currentStep = 'Blender: STL → OBJ';
        log(`Step 2: STL → OBJ via Blender...`);
        await blenderConvert(tempStlPath, tempObjPath);
        stepsCompleted.push('Blender: STL → OBJ');
        log(`Step 2 complete`, 'success');

        currentStep = 'mesh_to_ifc: OBJ → IFC';
        log(`Step 3: OBJ → IFC via mesh_to_ifc...`);
        await meshToIfc(tempObjPath, outputPath);
        stepsCompleted.push('mesh_to_ifc: OBJ → IFC');
        log(`Step 3 complete`, 'success');

        return {
          outputPath,
          tool: 'pipeline',
          duration: Date.now() - startTime
        };
      } catch (err) {
        log(`STEP/IGES → IFC failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        throw new ConversionError(
          `Failed to convert ${inputFormat.toUpperCase()} to IFC`,
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        await fs.remove(tempStlPath).catch(() => {});
        await fs.remove(tempObjPath).catch(() => {});
      }
    }

    // STEP/IGES → Mesh formats (FreeCAD → STL → Blender/Assimp)
    log(`STEP/IGES → mesh format via FreeCAD...`);
    const tempStlPath = path.join(inputDir, `temp_${Date.now()}.stl`);
    try {
      // Step 1: Convert to STL via existing FreeCAD exporter
      currentStep = `FreeCAD: ${inputFormat.toUpperCase()} → STL`;
      log(`Step 1: ${inputFormat.toUpperCase()} → STL via FreeCAD...`);
      const freecadResult = await convertWithFreecad(inputPath, 'stl');
      await fs.move(freecadResult.outputPath, tempStlPath, { overwrite: true });
      stepsCompleted.push(`FreeCAD: ${inputFormat.toUpperCase()} → STL`);
      log(`Step 1 complete`, 'success');
      
      // Step 2: STL → final format
      if (normalizedOutputFormat === 'stl') {
        await fs.move(tempStlPath, outputPath, { overwrite: true });
      } else {
        currentStep = `Fallback: STL → ${normalizedOutputFormat.toUpperCase()}`;
        log(`Step 2: STL → ${normalizedOutputFormat.toUpperCase()}...`);
        await convertWithFullFallback(tempStlPath, outputPath);
        stepsCompleted.push(`Fallback: STL → ${normalizedOutputFormat.toUpperCase()}`);
        log(`Step 2 complete`, 'success');
      }
      
      return {
        outputPath,
        tool: 'pipeline',
        duration: Date.now() - startTime
      };
    } catch (err) {
      log(`STEP/IGES → mesh failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      throw new ConversionError(
        `Failed to convert ${inputFormat.toUpperCase()} to ${normalizedOutputFormat.toUpperCase()}`,
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      await fs.remove(tempStlPath).catch(() => {});
    }
  }
  
  // 5b. Any format → STEP/IGES OUTPUT
  //     Skip IFC input (handled by Route 6a via IfcConvert)
  if ((isStepOutput || isIgesOutput) && !isIfcFormat(inputFormat)) {
    currentRoute = `Any → ${normalizedOutputFormat.toUpperCase()} (Blender+FreeCAD)`;
    log(`Route: Any → ${normalizedOutputFormat.toUpperCase()}`);
    
    const tempStlPath = path.join(inputDir, `temp_${Date.now()}.stl`);
    
    try {
      // Step 1: Convert to clean STL via Blender (sanitizes mesh + decimates for FreeCAD)
      // Note: DWG/DXF input is handled by Route 3 before reaching here
      currentStep = `Blender: ${inputFormat.toUpperCase()} → STL (decimated)`;
      log(`Step 1: Blender → STL (sanitized + decimated)...`);
      try {
        await blenderConvert(inputPath, tempStlPath, { decimateTargetFaces: 10000 });
      } catch (blenderErr) {
        // Blender failed (e.g., can't import 3DS), try via Assimp intermediate OBJ
        if (isSimpleMesh(inputFormat)) {
          log(`Blender failed, trying via intermediate OBJ...`, 'warn');
          const tempObjPath = path.join(inputDir, `temp_obj_${Date.now()}.obj`);
          try {
            await assimpConvert(inputPath, tempObjPath);
            await blenderConvert(tempObjPath, tempStlPath, { decimateTargetFaces: 10000 });
          } finally {
            await fs.remove(tempObjPath).catch(() => {});
          }
        } else {
          throw blenderErr;
        }
      }
      stepsCompleted.push(`${inputFormat.toUpperCase()} → STL (decimated)`);
      log(`Step 1 complete`, 'success');
      
      // Step 2: STL → STEP/IGES via FreeCAD
      if (isStepOutput) {
        currentStep = 'FreeCAD: STL → STEP (solidification)';
        log(`Step 2: STL → STEP via FreeCAD (solidification)...`);
        await convertMeshToStep(tempStlPath, outputPath);
        stepsCompleted.push('FreeCAD: STL → STEP (solidification)');
      } else {
        // For IGES: STL → STEP → IGES
        currentStep = 'FreeCAD: STL → STEP → IGES';
        log(`Step 2: STL → STEP → IGES via FreeCAD...`);
        const tempStepPath = path.join(inputDir, `temp_step_${Date.now()}.step`);
        await convertMeshToStep(tempStlPath, tempStepPath);
        await convertCadToCad(tempStepPath, outputPath);
        await fs.remove(tempStepPath).catch(() => {});
        stepsCompleted.push('FreeCAD: STL → STEP → IGES');
      }
      log(`Step 2 complete`, 'success');
      
      return {
        outputPath,
        tool: 'pipeline',
        duration: Date.now() - startTime
      };
    } catch (err) {
      log(`Mesh → ${normalizedOutputFormat.toUpperCase()} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      throw new ConversionError(
        `Failed to convert ${inputFormat.toUpperCase()} to ${normalizedOutputFormat.toUpperCase()}`,
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      await fs.remove(tempStlPath).catch(() => {});
    }
  }

  // =====================================================
  // 6. IFC ROUTING (IfcOpenShell-based)
  // =====================================================
  const isIfcInput = isIfcFormat(inputFormat);
  const isIfcOutput = isIfcFormat(normalizedOutputFormat);
  
  // 6a. IFC INPUT → Any format (Use IfcConvert)
  if (isIfcInput) {
    currentRoute = `IFC input → ${normalizedOutputFormat.toUpperCase()}`;
    log(`Route: IFC input → ${normalizedOutputFormat.toUpperCase()}`);
    
    // Check if IfcConvert is available
    if (!isIfcConvertAvailable()) {
      log(`IfcConvert not available`, 'error');
      throw new ConversionError(
        'IFC conversion requires IfcConvert',
        'IfcConvert binary not found. Make sure IfcOpenShell is installed in the Docker container.'
      );
    }
    
    // Check if IfcConvert can directly output this format
    if (IFC_CONVERT_NATIVE_FORMATS.includes(normalizedOutputFormat)) {
      log(`IfcConvert direct: IFC → ${normalizedOutputFormat.toUpperCase()}...`);
      try {
        currentStep = `IfcConvert: IFC → ${normalizedOutputFormat.toUpperCase()}`;
        await ifcConvert(inputPath, outputPath, {
          useElementNames: true,
          centerModel: true
        });
        stepsCompleted.push(`IfcConvert: IFC → ${normalizedOutputFormat.toUpperCase()}`);
        log(`IfcConvert successful`, 'success');
        return {
          outputPath,
          tool: 'ifcopenshell',
          duration: Date.now() - startTime
        };
      } catch (err) {
        log(`IfcConvert direct failed: ${err instanceof Error ? err.message : String(err)}, falling back to OBJ pipeline...`, 'warn');
        // Fall through to OBJ pipeline below
      }
    }

    // For formats not natively supported by IfcConvert (or when direct fails), go IFC → OBJ → target
    log(`Pipeline: IFC → OBJ → ${normalizedOutputFormat.toUpperCase()}`);
    const tempObjPath = path.join(inputDir, `temp_${Date.now()}.obj`);

    try {
      // Step 1: IFC → OBJ via IfcConvert
      currentStep = 'IfcConvert: IFC → OBJ';
      log(`Step 1: IFC → OBJ via IfcConvert...`);
      await ifcConvert(inputPath, tempObjPath, {
        useElementNames: true,
        centerModel: true
      });
      stepsCompleted.push('IfcConvert: IFC → OBJ');
      log(`Step 1 complete`, 'success');

      // Step 2: OBJ → target format
      // DWG needs OBJ → DXF → DWG pipeline (Blender + ODA)
      if (normalizedOutputFormat === 'dwg') {
        const tempDxfPath = path.join(inputDir, `temp_dxf_${Date.now()}.dxf`);
        try {
          currentStep = 'Blender: OBJ → DXF';
          log(`Step 2a: OBJ → DXF via Blender...`);
          await blenderConvert(tempObjPath, tempDxfPath);
          stepsCompleted.push('Blender: OBJ → DXF');
          log(`Step 2a complete`, 'success');

          currentStep = 'ODA: DXF → DWG';
          log(`Step 2b: DXF → DWG via ODA...`);
          const odaOutputPath = await odaConvert(tempDxfPath, 'DWG');
          stepsCompleted.push('ODA: DXF → DWG');
          if (odaOutputPath !== outputPath) {
            await fs.move(odaOutputPath, outputPath, { overwrite: true });
          }
          log(`Step 2b complete`, 'success');
        } finally {
          await fs.remove(tempDxfPath).catch(() => {});
        }
      } else if (isStepFormat(normalizedOutputFormat) || isIgesFormat(normalizedOutputFormat)) {
      // STEP/IGES need specialized FreeCAD solidification pipeline
        const tempStlPath = path.join(inputDir, `temp_stl_${Date.now()}.stl`);
        try {
          currentStep = 'Blender: OBJ → STL (decimated)';
          log(`Step 2a: OBJ → STL via Blender (decimated)...`);
          await blenderConvert(tempObjPath, tempStlPath, { decimateTargetFaces: 10000 });
          stepsCompleted.push('Blender: OBJ → STL (decimated)');
          log(`Step 2a complete`, 'success');

          if (isStepFormat(normalizedOutputFormat)) {
            currentStep = 'FreeCAD: STL → STEP (solidification)';
            log(`Step 2b: STL → STEP via FreeCAD (solidification)...`);
            await convertMeshToStep(tempStlPath, outputPath);
            stepsCompleted.push('FreeCAD: STL → STEP (solidification)');
          } else {
            // IGES: STL → STEP → IGES
            const tempStepPath = path.join(inputDir, `temp_step_${Date.now()}.step`);
            currentStep = 'FreeCAD: STL → STEP → IGES';
            log(`Step 2b: STL → STEP → IGES via FreeCAD...`);
            await convertMeshToStep(tempStlPath, tempStepPath);
            await convertCadToCad(tempStepPath, outputPath);
            await fs.remove(tempStepPath).catch(() => {});
            stepsCompleted.push('FreeCAD: STL → STEP → IGES');
          }
          log(`Step 2 complete`, 'success');
        } finally {
          await fs.remove(tempStlPath).catch(() => {});
        }
      } else {
        currentStep = `Fallback: OBJ → ${normalizedOutputFormat.toUpperCase()}`;
        log(`Step 2: OBJ → ${normalizedOutputFormat.toUpperCase()}...`);
        await convertWithFullFallback(tempObjPath, outputPath);
        stepsCompleted.push(`Fallback: OBJ → ${normalizedOutputFormat.toUpperCase()}`);
        log(`Step 2 complete`, 'success');
      }
      
      return {
        outputPath,
        tool: 'pipeline',
        duration: Date.now() - startTime
      };
    } catch (err) {
      log(`IFC pipeline failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      throw new ConversionError(
        `Failed to convert IFC to ${normalizedOutputFormat.toUpperCase()}`,
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      await fs.remove(tempObjPath).catch(() => {});
    }
  }
  
  // 6b. Any format → IFC OUTPUT (Use mesh_to_ifc.py)
  if (isIfcOutput) {
    currentRoute = `${inputFormat.toUpperCase()} → IFC`;
    log(`Route: ${inputFormat.toUpperCase()} → IFC`);
    
    const tempObjPath = path.join(inputDir, `temp_${Date.now()}.obj`);
    
    try {
      // Step 1: Convert to OBJ via Blender (preserves groups/hierarchy)
      if (inputFormat === 'obj') {
        // Already OBJ, use directly
        log(`Input is already OBJ, using directly...`);
        await fs.copy(inputPath, tempObjPath);
        stepsCompleted.push('Copy OBJ input');
      } else {
        // Other formats → OBJ via Blender (fallback: Assimp for mesh formats)
        currentStep = `Blender: ${inputFormat.toUpperCase()} → OBJ`;
        log(`Step 1: ${inputFormat.toUpperCase()} → OBJ via Blender...`);
        try {
          await blenderConvert(inputPath, tempObjPath);
        } catch (blenderErr) {
          // Blender failed (e.g., can't import 3DS), try Assimp
          if (isSimpleMesh(inputFormat)) {
            log(`Blender failed, trying Assimp...`, 'warn');
            await assimpConvert(inputPath, tempObjPath);
          } else {
            throw blenderErr;
          }
        }
        stepsCompleted.push(`${inputFormat.toUpperCase()} → OBJ`);
        log(`Step 1 complete`, 'success');
      }
      
      // Step 2: OBJ → IFC via mesh_to_ifc.py
      currentStep = 'mesh_to_ifc: OBJ → IFC';
      log(`Step 2: OBJ → IFC via mesh_to_ifc.py...`);
      await meshToIfc(tempObjPath, outputPath);
      stepsCompleted.push('mesh_to_ifc: OBJ → IFC');
      log(`Step 2 complete`, 'success');
      
      log(`Pipeline complete: ${inputFormat.toUpperCase()} → OBJ → IFC`, 'success');
      return {
        outputPath,
        tool: 'ifcopenshell',
        duration: Date.now() - startTime
      };
    } catch (err) {
      log(`Mesh → IFC failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      throw new ConversionError(
        `Failed to convert ${inputFormat.toUpperCase()} to IFC`,
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      await fs.remove(tempObjPath).catch(() => {});
    }
  }

  // =====================================================
  // 7. SIMPLE MESH → SIMPLE MESH: Assimp → Blender → FreeCAD
  // =====================================================
  if (isSimpleMesh(inputFormat) && isSimpleMesh(normalizedOutputFormat)) {
    currentRoute = 'Simple mesh → Simple mesh (fallback chain)';
    currentStep = `Fallback chain: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`;
    log(`Route: Simple mesh → Simple mesh`);
    
    tool = await convertWithFullFallback(inputPath, outputPath);
    stepsCompleted.push(`Fallback chain: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()} (${tool})`);
    
    log(`Conversion complete using ${tool}`, 'success');
    return {
      outputPath,
      tool,
      duration: Date.now() - startTime
    };
  }

  // =====================================================
  // 8. CAD FORMATS: Blender → FreeCAD
  // =====================================================
  if (isCadFormat(inputFormat) || isCadFormat(normalizedOutputFormat)) {
    currentRoute = 'CAD format conversion (Blender → FreeCAD)';
    log(`Route: CAD format conversion`);
    log(`Trying Blender...`);
    
    try {
      currentStep = `Blender: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`;
      await blenderConvert(inputPath, outputPath);
      stepsCompleted.push(`Blender: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`);
      log(`Blender conversion successful`, 'success');
      return {
        outputPath,
        tool: 'blender',
        duration: Date.now() - startTime
      };
    } catch (blenderErr) {
      log(`Blender failed, trying FreeCAD...`, 'warn');
      
      // Cast for flexible comparison
      const outFmt = normalizedOutputFormat as string;
      
      if (canFreecadHandle(inputFormat)) {
        const tempStlPath = path.join(inputDir, `temp_${Date.now()}.stl`);
        try {
          currentStep = `FreeCAD: ${inputFormat.toUpperCase()} → STL`;
          log(`Trying FreeCAD...`);
          const freecadResult = await convertWithFreecad(inputPath, 'stl');
          await fs.move(freecadResult.outputPath, tempStlPath, { overwrite: true });
          stepsCompleted.push(`FreeCAD: ${inputFormat.toUpperCase()} → STL`);
          log(`FreeCAD conversion successful`, 'success');
          
          if (outFmt === 'stl') {
            await fs.move(tempStlPath, outputPath, { overwrite: true });
          } else {
            currentStep = `Fallback: STL → ${outFmt.toUpperCase()}`;
            log(`Converting STL → ${outFmt.toUpperCase()}...`);
            await convertWithFullFallback(tempStlPath, outputPath);
            stepsCompleted.push(`Fallback: STL → ${outFmt.toUpperCase()}`);
          }
          
          log(`Pipeline complete`, 'success');
          return {
            outputPath,
            tool: 'pipeline',
            duration: Date.now() - startTime
          };
        } catch (freecadErr) {
          throw new ConversionError(
            `Failed to convert ${inputFormat.toUpperCase()} to ${normalizedOutputFormat.toUpperCase()}`,
            'All conversion methods failed (Blender, FreeCAD).'
          );
        } finally {
          await fs.remove(tempStlPath).catch(() => {});
        }
      }
      
      throw blenderErr;
    }
  }

  // =====================================================
  // 9. FALLBACK - Try full chain for any other formats
  // =====================================================
  currentRoute = 'Fallback chain';
  currentStep = `Fallback chain: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`;
  log(`Route: Fallback chain`);
  tool = await convertWithFullFallback(inputPath, outputPath);
  
  log(`Conversion complete using ${tool}`, 'success');
  stepsCompleted.push(`Fallback chain: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()} (${tool})`);
  return {
    outputPath,
    tool,
    duration: Date.now() - startTime
  };

  } catch (err) {
    // Log error to data/errorLogs file (only on error)
    await logConversionError({
      inputFormat,
      outputFormat: normalizedOutputFormat,
      fileName: inputFilename,
      route: currentRoute || 'Unknown',
      stepsCompleted,
      failedStep: currentStep || 'Unknown step',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Full fallback chain: Assimp → Blender → FreeCAD
 * Tries each converter in order until one succeeds
 *
 * Detects OBJ files with colon-notation groups (e.g., "g Obj.195:1")
 * which indicate parent-child relationships that Blender can preserve.
 */
async function convertWithFullFallback(
  inputPath: string,
  outputPath: string
): Promise<ConversionResult['tool']> {
  const inputFormat = getExtension(inputPath);
  const outputFormat = getExtension(outputPath);
  const inputDir = path.dirname(inputPath);

  log(`Fallback chain: ${inputFormat.toUpperCase()} → ${outputFormat.toUpperCase()}`);

  // Check if OBJ file has colon-notation groups (e.g., "g Obj.195:1")
  // These indicate parent-child relationships that Blender can group together
  const hasColonNotation = inputFormat === 'obj' &&
                           (outputFormat === 'glb' || outputFormat === 'gltf') &&
                           objHasColonNotationGroups(inputPath);

  const preferBlenderForHierarchy = hasColonNotation;

  if (hasColonNotation) {
    log(`OBJ has colon-notation groups - using Blender for GLB to create hierarchy`);
  }

  // 1. Try Assimp first (fast, good for simple meshes)
  // Skip Assimp if we need hierarchy preservation, FBX output (unreliable for reimport),
  // or glTF output (Assimp creates .gltf + external .bin which breaks single-file download)
  if (isSimpleMesh(inputFormat) && isSimpleMesh(outputFormat) && !preferBlenderForHierarchy
      && outputFormat !== 'fbx' && outputFormat !== 'gltf') {
    try {
      log(`Trying Assimp...`);
      await assimpConvert(inputPath, outputPath);
      log(`Assimp conversion successful`, 'success');
      return 'assimp';
    } catch (err) {
      log(`Assimp failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'warn');
    }
  }

  // 2. Try Blender
  try {
    log(`Trying Blender...`);
    await blenderConvert(inputPath, outputPath);
    log(`Blender conversion successful`, 'success');
    return 'blender';
  } catch (err) {
    log(`Blender failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'warn');
  }

  // 3. Try FreeCAD
  if (canFreecadHandle(inputFormat)) {
    const tempStlPath = path.join(inputDir, `temp_freecad_${Date.now()}.stl`);
    try {
      log(`Trying FreeCAD...`);
      const freecadResult = await convertWithFreecad(inputPath, 'stl');
      await fs.move(freecadResult.outputPath, tempStlPath, { overwrite: true });
      log(`FreeCAD conversion to STL successful`, 'success');
      
      if (outputFormat === 'stl') {
        await fs.move(tempStlPath, outputPath, { overwrite: true });
        log(`Output is STL, done`, 'success');
      } else {
        // Convert STL to final format via Blender
        log(`Converting STL → ${outputFormat.toUpperCase()} via Blender...`);
        await blenderConvert(tempStlPath, outputPath);
        log(`STL → ${outputFormat.toUpperCase()} successful`, 'success');
      }
      return 'pipeline';
    } catch (err) {
      log(`FreeCAD failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'warn');
    } finally {
      await fs.remove(tempStlPath).catch(() => {});
    }
  }

  // 4. Try via intermediate OBJ (when direct conversion fails)
  // This handles cases like: 3DS→DXF (Blender can't import Assimp 3DS),
  // DXF→glTF (Blender can't export glTF from DXF geometry), etc.
  if (inputFormat !== 'obj' && outputFormat !== 'obj') {
    const tempObjPath = path.join(inputDir, `temp_intermediate_${Date.now()}.obj`);
    try {
      log(`Trying via intermediate OBJ...`);
      // Convert input → OBJ (try Assimp first, then Blender)
      if (isSimpleMesh(inputFormat)) {
        try {
          await assimpConvert(inputPath, tempObjPath);
        } catch {
          await blenderConvert(inputPath, tempObjPath);
        }
      } else {
        await blenderConvert(inputPath, tempObjPath);
      }
      log(`Input → OBJ successful, converting OBJ → ${outputFormat.toUpperCase()}...`, 'success');

      // Convert OBJ → target (try Assimp first for mesh, then Blender)
      if (isSimpleMesh(outputFormat) && outputFormat !== 'fbx' && outputFormat !== 'gltf') {
        try {
          await assimpConvert(tempObjPath, outputPath);
          log(`OBJ → ${outputFormat.toUpperCase()} via Assimp successful`, 'success');
          return 'pipeline';
        } catch {
          // Fall through to Blender
        }
      }
      await blenderConvert(tempObjPath, outputPath);
      log(`OBJ → ${outputFormat.toUpperCase()} via Blender successful`, 'success');
      return 'pipeline';
    } catch (err) {
      log(`Intermediate OBJ fallback failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'warn');
    } finally {
      await fs.remove(tempObjPath).catch(() => {});
    }
  }

  // All methods failed
  log(`All conversion methods failed!`, 'error');
  throw new ConversionError(
    `Failed to convert ${inputFormat.toUpperCase()} to ${outputFormat.toUpperCase()}`,
    'All conversion methods failed (Assimp, Blender, FreeCAD). ' +
    'The file may be corrupted or in an unsupported format.'
  );
}