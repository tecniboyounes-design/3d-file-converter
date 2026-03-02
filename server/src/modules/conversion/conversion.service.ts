/**
 * Conversion Service - Smart routing between conversion tools
 * 
 * Decision Matrix:
 * 
 * 1. DXF ↔ DWG: Use ODA File Converter (direct format swap)
 * 
 * 2. Any format → DWG: Convert to DXF first (Blender), then DXF → DWG (ODA)
 * 
 * 3. DWG/DXF INPUT → Any format: Use Autodesk APS (handles ACIS 3D solids)
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
 * 7. Simple Mesh → Simple Mesh: Assimp → Blender → FreeCAD → APS (fallback chain)
 * 
 * 8. CAD formats: Blender → FreeCAD → APS (fallback chain)
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
  apsConvert,
  isApsAvailable,
  getHierarchyForObj,
  ifcConvert,
  meshToIfc,
  isIfcConvertAvailable,
  IFC_CONVERT_NATIVE_FORMATS
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
import { 
  isSupportedInputFormat, 
  isSupportedOutputFormat,
  isIfcFormat
} from '../../common/constants';

interface ConversionResult {
  outputPath: string;
  tool: 'assimp' | 'blender' | 'oda' | 'pipeline' | 'aps' | 'ifcopenshell';
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
 */
export async function convertFile(
  inputPath: string,
  outputFormat: string
): Promise<ConversionResult> {
  const startTime = Date.now();
  const inputFormat = getExtension(inputPath);
  const normalizedOutputFormat = outputFormat.toLowerCase();
  const inputFilename = path.basename(inputPath);

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
    log(`Route: DXF ↔ DWG swap`);
    log(`Trying ODA File Converter...`);
    const odaOutputFormat = normalizedOutputFormat.toUpperCase() as 'DXF' | 'DWG';
    try {
      const odaOutputPath = await odaConvert(inputPath, odaOutputFormat);
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
  // =====================================================
  if (normalizedOutputFormat === 'dwg' && inputFormat !== 'dxf') {
    log(`Route: Any → DWG (via DXF intermediate)`);
    const tempDxfPath = path.join(inputDir, `temp_${Date.now()}.dxf`);
    
    try {
      // Step 1: Convert to DXF via Blender
      log(`Step 1: Trying Blender (${inputFormat.toUpperCase()} → DXF)...`);
      await blenderConvert(inputPath, tempDxfPath);
      log(`Step 1: Blender conversion successful`, 'success');
      
      // Step 2: Convert DXF to DWG via ODA
      log(`Step 2: Trying ODA (DXF → DWG)...`);
      const odaOutputPath = await odaConvert(tempDxfPath, 'DWG');
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
  // 3. DWG/DXF INPUT → Any format (APS with ODA fallback)
  // =====================================================
  const inputIsDwgDxf = isDwgFormat(inputFormat) || inputFormat === 'dxf';

  if (inputIsDwgDxf) {
    log(`Route: DWG/DXF input → ${normalizedOutputFormat.toUpperCase()} output`);

    const outFmt = normalizedOutputFormat as string;
    let apsError: string | null = null;

    // --- Try APS first (best for ACIS solids) ---
    if (isApsAvailable()) {
      // Direct to OBJ/STL via APS
      if (outFmt === 'obj' || outFmt === 'stl') {
        try {
          log(`Trying APS direct (${inputFormat.toUpperCase()} → ${outFmt.toUpperCase()})...`);
          await apsConvert(inputPath, outputPath, {
            outputFormat: outFmt as 'obj' | 'stl'
          });
          log(`APS conversion successful`, 'success');
          return {
            outputPath,
            tool: 'aps',
            duration: Date.now() - startTime
          };
        } catch (err) {
          apsError = err instanceof Error ? err.message : String(err);
          log(`APS failed: ${apsError}`, 'warn');
        }
      } else {
        // Other formats: DWG/DXF → OBJ → target format via APS
        const tempObjPath = path.join(inputDir, `temp_aps_${Date.now()}.obj`);
        try {
          log(`Pipeline: APS (${inputFormat.toUpperCase()} → OBJ) → ${outFmt.toUpperCase()}`);
          await apsConvert(inputPath, tempObjPath, { outputFormat: 'obj' });
          log(`APS → OBJ successful`, 'success');

          log(`Converting OBJ → ${outFmt.toUpperCase()}...`);
          await convertWithFullFallback(tempObjPath, outputPath);
          log(`Pipeline complete via APS`, 'success');
          return {
            outputPath,
            tool: 'pipeline',
            duration: Date.now() - startTime
          };
        } catch (err) {
          apsError = err instanceof Error ? err.message : String(err);
          log(`APS pipeline failed: ${apsError}`, 'warn');
        } finally {
          await fs.remove(tempObjPath).catch(() => {});
        }
      }
    } else {
      apsError = 'APS not configured (missing credentials)';
      log(`${apsError}`, 'warn');
    }

    // --- Fallback: ODA (DWG→DXF) + Blender/FreeCAD pipeline ---
    log(`Falling back to ODA + local tools pipeline...`);
    const tempDxfPath = path.join(inputDir, `temp_oda_${Date.now()}.dxf`);

    try {
      // Step 1: DWG → DXF via ODA (skip if input is already DXF)
      let dxfPath = inputPath;
      if (isDwgFormat(inputFormat)) {
        log(`Step 1: ODA (DWG → DXF)...`);
        const odaResult = await dwgToDxf(inputPath);
        await fs.move(odaResult, tempDxfPath, { overwrite: true });
        dxfPath = tempDxfPath;
        log(`Step 1: ODA conversion successful`, 'success');
      }

      // Step 2: Route DXF → target format
      if (isStepFormat(outFmt) || isIgesFormat(outFmt)) {
        // DXF → STL (Blender with decimation) → STP/IGES (FreeCAD solidification)
        const tempStlPath = path.join(inputDir, `temp_stl_${Date.now()}.stl`);
        try {
          log(`Step 2: Blender (DXF → decimated STL)...`);
          await blenderConvert(dxfPath, tempStlPath, { decimateTargetFaces: 20000 });
          log(`Step 2: Blender successful`, 'success');

          log(`Step 3: FreeCAD (STL → ${outFmt.toUpperCase()})...`);
          await convertMeshToStep(tempStlPath, outputPath);
          log(`Step 3: FreeCAD solidification successful`, 'success');
        } finally {
          await fs.remove(tempStlPath).catch(() => {});
        }
      } else {
        // DXF → target mesh format via Blender/Assimp fallback chain
        log(`Step 2: DXF → ${outFmt.toUpperCase()} via fallback chain...`);
        await convertWithFullFallback(dxfPath, outputPath);
        log(`Step 2: Conversion successful`, 'success');
      }

      log(`Pipeline complete via ODA fallback`, 'success');
      return {
        outputPath,
        tool: 'pipeline',
        duration: Date.now() - startTime
      };
    } catch (err) {
      const odaError = err instanceof Error ? err.message : String(err);
      log(`ODA fallback pipeline failed: ${odaError}`, 'error');
      throw new ConversionError(
        `Failed to convert ${inputFormat.toUpperCase()} to ${normalizedOutputFormat.toUpperCase()}`,
        `APS failed: ${apsError}. ODA fallback also failed: ${odaError}`
      );
    } finally {
      await fs.remove(tempDxfPath).catch(() => {});
    }
  }

  // =====================================================
  // 4. Any format → DXF (Use Blender)
  // =====================================================
  if (normalizedOutputFormat === 'dxf') {
    log(`Route: Any → DXF`);
    log(`Trying Blender...`);
    try {
      await blenderConvert(inputPath, outputPath);
      log(`Blender conversion successful`, 'success');
      return {
        outputPath,
        tool: 'blender',
        duration: Date.now() - startTime
      };
    } catch (blenderErr) {
      log(`Blender failed: ${blenderErr instanceof Error ? blenderErr.message : String(blenderErr)}`, 'error');
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
    log(`Route: STEP/IGES input → ${normalizedOutputFormat.toUpperCase()}`);
    
    // STEP/IGES → STEP/IGES (CAD-to-CAD via FreeCAD)
    if (isStepOutput || isIgesOutput) {
      log(`CAD-to-CAD conversion: ${inputFormat.toUpperCase()} → ${normalizedOutputFormat.toUpperCase()}`);
      try {
        await convertCadToCad(inputPath, outputPath);
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
        await convertCadToCad(inputPath, outputPath);
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
        log(`Step 1: ${inputFormat.toUpperCase()} → DXF via FreeCAD...`);
        await convertCadToCad(inputPath, tempDxfPath);
        log(`Step 1 complete`, 'success');
        
        // Step 2: DXF → DWG via ODA
        log(`Step 2: DXF → DWG via ODA...`);
        const odaOutputPath = await odaConvert(tempDxfPath, 'DWG');
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
    
    // STEP/IGES → Mesh formats (FreeCAD → STL → Blender/Assimp)
    log(`STEP/IGES → mesh format via FreeCAD...`);
    const tempStlPath = path.join(inputDir, `temp_${Date.now()}.stl`);
    try {
      // Step 1: Convert to STL via existing FreeCAD exporter
      log(`Step 1: ${inputFormat.toUpperCase()} → STL via FreeCAD...`);
      const freecadResult = await convertWithFreecad(inputPath, 'stl');
      await fs.move(freecadResult.outputPath, tempStlPath, { overwrite: true });
      log(`Step 1 complete`, 'success');
      
      // Step 2: STL → final format
      if (normalizedOutputFormat === 'stl') {
        await fs.move(tempStlPath, outputPath, { overwrite: true });
      } else {
        log(`Step 2: STL → ${normalizedOutputFormat.toUpperCase()}...`);
        await convertWithFullFallback(tempStlPath, outputPath);
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
  if (isStepOutput || isIgesOutput) {
    log(`Route: Any → ${normalizedOutputFormat.toUpperCase()}`);
    
    const tempStlPath = path.join(inputDir, `temp_${Date.now()}.stl`);
    
    try {
      // Step 1: Convert to clean STL via Blender
      if ((inputFormat as string) === 'dwg' || (inputFormat as string) === 'dxf') {
        // DWG/DXF → OBJ via APS, then → STL
        log(`Step 1: DWG/DXF → OBJ via APS, then → STL...`);
        if (!isApsAvailable()) {
          throw new ConversionError(
            'DWG/DXF to STEP conversion requires Autodesk APS',
            'Configure APS_CLIENT_ID and APS_CLIENT_SECRET environment variables.'
          );
        }
        const tempObjPath = path.join(inputDir, `temp_aps_${Date.now()}.obj`);
        await apsConvert(inputPath, tempObjPath, { outputFormat: 'obj' });
        await blenderConvert(tempObjPath, tempStlPath);
        await fs.remove(tempObjPath).catch(() => {});
        log(`Step 1 complete`, 'success');
      } else {
        // Mesh format → STL via Blender (sanitizes mesh)
        log(`Step 1: Blender → STL (sanitized)...`);
        await blenderConvert(inputPath, tempStlPath);
        log(`Step 1 complete`, 'success');
      }
      
      // Step 2: STL → STEP/IGES via FreeCAD
      if (isStepOutput) {
        log(`Step 2: STL → STEP via FreeCAD (solidification)...`);
        await convertMeshToStep(tempStlPath, outputPath);
      } else {
        // For IGES: STL → STEP → IGES
        log(`Step 2: STL → STEP → IGES via FreeCAD...`);
        const tempStepPath = path.join(inputDir, `temp_step_${Date.now()}.step`);
        await convertMeshToStep(tempStlPath, tempStepPath);
        await convertCadToCad(tempStepPath, outputPath);
        await fs.remove(tempStepPath).catch(() => {});
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
        await ifcConvert(inputPath, outputPath, {
          useElementNames: true,
          centerModel: true
        });
        log(`IfcConvert successful`, 'success');
        return {
          outputPath,
          tool: 'ifcopenshell',
          duration: Date.now() - startTime
        };
      } catch (err) {
        log(`IfcConvert failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        throw new ConversionError(
          `Failed to convert IFC to ${normalizedOutputFormat.toUpperCase()}`,
          `IfcConvert failed. Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    
    // For formats not natively supported by IfcConvert, go IFC → OBJ → target
    log(`Pipeline: IFC → OBJ → ${normalizedOutputFormat.toUpperCase()}`);
    const tempObjPath = path.join(inputDir, `temp_${Date.now()}.obj`);
    
    try {
      // Step 1: IFC → OBJ via IfcConvert
      log(`Step 1: IFC → OBJ via IfcConvert...`);
      await ifcConvert(inputPath, tempObjPath, {
        useElementNames: true,
        centerModel: true
      });
      log(`Step 1 complete`, 'success');
      
      // Step 2: OBJ → target format
      log(`Step 2: OBJ → ${normalizedOutputFormat.toUpperCase()}...`);
      await convertWithFullFallback(tempObjPath, outputPath);
      log(`Step 2 complete`, 'success');
      
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
    log(`Route: ${inputFormat.toUpperCase()} → IFC`);
    
    const tempObjPath = path.join(inputDir, `temp_${Date.now()}.obj`);
    
    try {
      // Step 1: Convert to OBJ via Blender (preserves groups/hierarchy)
      if (inputFormat === 'obj') {
        // Already OBJ, use directly
        log(`Input is already OBJ, using directly...`);
        await fs.copy(inputPath, tempObjPath);
      } else if ((inputFormat as string) === 'dwg' || (inputFormat as string) === 'dxf') {
        // DWG/DXF → OBJ via APS
        log(`Step 1: DWG/DXF → OBJ via APS...`);
        if (!isApsAvailable()) {
          throw new ConversionError(
            'DWG/DXF to IFC conversion requires Autodesk APS',
            'Configure APS_CLIENT_ID and APS_CLIENT_SECRET environment variables.'
          );
        }
        await apsConvert(inputPath, tempObjPath, { outputFormat: 'obj' });
        log(`Step 1 complete`, 'success');
      } else {
        // Other formats → OBJ via Blender
        log(`Step 1: ${inputFormat.toUpperCase()} → OBJ via Blender...`);
        await blenderConvert(inputPath, tempObjPath);
        log(`Step 1 complete`, 'success');
      }
      
      // Step 2: OBJ → IFC via mesh_to_ifc.py
      log(`Step 2: OBJ → IFC via mesh_to_ifc.py...`);
      await meshToIfc(tempObjPath, outputPath);
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
  // 7. SIMPLE MESH → SIMPLE MESH: Assimp → Blender → FreeCAD → APS
  // =====================================================
  if (isSimpleMesh(inputFormat) && isSimpleMesh(normalizedOutputFormat)) {
    log(`Route: Simple mesh → Simple mesh`);
    
    tool = await convertWithFullFallback(inputPath, outputPath);
    
    log(`Conversion complete using ${tool}`, 'success');
    return {
      outputPath,
      tool,
      duration: Date.now() - startTime
    };
  }

  // =====================================================
  // 8. CAD FORMATS: Blender → FreeCAD → APS
  // =====================================================
  if (isCadFormat(inputFormat) || isCadFormat(normalizedOutputFormat)) {
    log(`Route: CAD format conversion`);
    log(`Trying Blender...`);
    
    try {
      await blenderConvert(inputPath, outputPath);
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
          log(`Trying FreeCAD...`);
          const freecadResult = await convertWithFreecad(inputPath, 'stl');
          await fs.move(freecadResult.outputPath, tempStlPath, { overwrite: true });
          log(`FreeCAD conversion successful`, 'success');
          
          if (outFmt === 'stl') {
            await fs.move(tempStlPath, outputPath, { overwrite: true });
          } else {
            log(`Converting STL → ${outFmt.toUpperCase()}...`);
            await convertWithFullFallback(tempStlPath, outputPath);
          }
          
          log(`Pipeline complete`, 'success');
          return {
            outputPath,
            tool: 'pipeline',
            duration: Date.now() - startTime
          };
        } catch (freecadErr) {
          log(`FreeCAD failed, trying APS as last resort...`, 'warn');
          
          // Try APS as ultimate fallback
          if (isApsAvailable()) {
            try {
              log(`Trying APS...`);
              const tempObjPath = path.join(inputDir, `temp_aps_${Date.now()}.obj`);
              await apsConvert(inputPath, tempObjPath, { outputFormat: 'obj' });
              log(`APS conversion successful`, 'success');
              
              if (outFmt === 'obj') {
                await fs.move(tempObjPath, outputPath, { overwrite: true });
              } else {
                log(`Converting OBJ → ${outFmt.toUpperCase()}...`);
                await convertWithFullFallback(tempObjPath, outputPath);
                await fs.remove(tempObjPath).catch(() => {});
              }
              
              log(`Pipeline complete`, 'success');
              return {
                outputPath,
                tool: 'aps',
                duration: Date.now() - startTime
              };
            } catch (apsErr) {
              log(`APS also failed`, 'error');
            }
          }
          
          throw new ConversionError(
            `Failed to convert ${inputFormat.toUpperCase()} to ${normalizedOutputFormat.toUpperCase()}`,
            'All conversion methods failed (Blender, FreeCAD, APS).'
          );
        } finally {
          await fs.remove(tempStlPath).catch(() => {});
        }
      }
      
      // FreeCAD can't handle this format, try APS directly
      if (isApsAvailable()) {
        log(`FreeCAD cannot handle ${inputFormat}, trying APS directly...`);
        try {
          log(`Trying APS...`);
          const tempObjPath = path.join(inputDir, `temp_aps_${Date.now()}.obj`);
          await apsConvert(inputPath, tempObjPath, { outputFormat: 'obj' });
          log(`APS conversion successful`, 'success');
          
          if (outFmt === 'obj') {
            await fs.move(tempObjPath, outputPath, { overwrite: true });
          } else {
            log(`Converting OBJ → ${outFmt.toUpperCase()}...`);
            await convertWithFullFallback(tempObjPath, outputPath);
            await fs.remove(tempObjPath).catch(() => {});
          }
          
          log(`Pipeline complete`, 'success');
          return {
            outputPath,
            tool: 'aps',
            duration: Date.now() - startTime
          };
        } catch (apsErr) {
          log(`APS also failed`, 'error');
        }
      }
      
      throw blenderErr;
    }
  }

  // =====================================================
  // 9. FALLBACK - Try full chain for any other formats
  // =====================================================
  log(`Route: Fallback chain`);
  tool = await convertWithFullFallback(inputPath, outputPath);
  
  log(`Conversion complete using ${tool}`, 'success');
  return {
    outputPath,
    tool,
    duration: Date.now() - startTime
  };
}

/**
 * Full fallback chain: Assimp → Blender → FreeCAD → APS
 * Tries each converter in order until one succeeds
 * 
 * HIERARCHY PRESERVATION:
 * When converting OBJ files from APS that have hierarchy data,
 * we skip Assimp and go directly to Blender so parent-child
 * relationships can be reconstructed in GLB/GLTF output.
 * 
 * Also detects OBJ files with colon-notation groups (e.g., "g Obj.195:1")
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

  // Check if we have APS hierarchy data for this OBJ file
  // If so, we MUST use Blender to preserve parent-child relationships in GLB/GLTF
  const hasApsHierarchyData = inputFormat === 'obj' && 
                           (outputFormat === 'glb' || outputFormat === 'gltf') &&
                           getHierarchyForObj(inputPath) !== undefined;
  
  // Also check if OBJ file has colon-notation groups (e.g., "g Obj.195:1")
  // These indicate parent-child relationships that Blender can group together
  const hasColonNotation = inputFormat === 'obj' && 
                           (outputFormat === 'glb' || outputFormat === 'gltf') &&
                           !hasApsHierarchyData && // Only check file if no APS data
                           objHasColonNotationGroups(inputPath);
  
  const preferBlenderForHierarchy = hasApsHierarchyData || hasColonNotation;
  
  if (hasApsHierarchyData) {
    log(`OBJ has APS hierarchy data - using Blender for GLB to preserve parent-child relationships`);
  } else if (hasColonNotation) {
    log(`OBJ has colon-notation groups - using Blender for GLB to create hierarchy`);
  }

  // 1. Try Assimp first (fast, good for simple meshes)
  // Skip Assimp if we need hierarchy preservation
  if (isSimpleMesh(inputFormat) && isSimpleMesh(outputFormat) && !preferBlenderForHierarchy) {
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

  // 4. Try APS as ultimate fallback
  if (isApsAvailable()) {
    const tempObjPath = path.join(inputDir, `temp_aps_${Date.now()}.obj`);
    try {
      log(`Trying APS as last resort...`);
      await apsConvert(inputPath, tempObjPath, { outputFormat: 'obj' });
      log(`APS conversion to OBJ successful`, 'success');
      
      if (outputFormat === 'obj') {
        await fs.move(tempObjPath, outputPath, { overwrite: true });
        log(`Output is OBJ, done`, 'success');
      } else {
        log(`Converting OBJ → ${outputFormat.toUpperCase()} via Blender...`);
        await blenderConvert(tempObjPath, outputPath);
        log(`OBJ → ${outputFormat.toUpperCase()} successful`, 'success');
        await fs.remove(tempObjPath).catch(() => {});
      }
      return 'aps';
    } catch (err) {
      log(`APS failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      await fs.remove(tempObjPath).catch(() => {});
    }
  }

  // All methods failed
  log(`All conversion methods failed!`, 'error');
  throw new ConversionError(
    `Failed to convert ${inputFormat.toUpperCase()} to ${outputFormat.toUpperCase()}`,
    'All conversion methods failed (Assimp, Blender, FreeCAD, APS). ' +
    'The file may be corrupted or in an unsupported format.'
  );
}