/**
 * Conversion Service - Smart routing between conversion tools
 * 
 * Decision Matrix:
 * - Simple mesh (OBJ, STL, PLY, GLB, GLTF): Try Assimp first, fallback to Blender
 * - CAD formats (DXF): Use Blender, fallback to FreeCAD for 3D solids
 * - Binary DXF: ODA → ASCII DXF → Blender/FreeCAD
 * - DWG input: ODA → DXF → target via Blender/FreeCAD/Assimp
 * - DWG output: Source → DXF via Blender → DWG via ODA
 */

import path from 'path';
import fs from 'fs-extra';
import { 
  blenderConvert, 
  assimpConvert, 
  odaConvert, 
  dwgToDxf,
  binaryDxfToAscii,
  convertWithFreecad,
  canFreecadHandle,
  apsConvert,
  isApsAvailable,
  likelyHasAcisSolids
} from './providers';
import { 
  isSimpleMesh, 
  isCadFormat, 
  isDwgFormat, 
  isDxfFile,
  isBinaryDxf,
  getExtension,
  generateOutputFilename 
} from '../../common/utils';
import { 
  ConversionError, 
  UnsupportedFormatError 
} from '../../common/errors';
import { 
  isSupportedInputFormat, 
  isSupportedOutputFormat 
} from '../../common/constants';

interface ConversionResult {
  outputPath: string;
  tool: 'assimp' | 'blender' | 'oda' | 'pipeline' | 'aps';
  duration: number;
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

  // Validate formats
  if (!isSupportedInputFormat(inputFormat)) {
    throw new UnsupportedFormatError(inputFormat);
  }
  if (!isSupportedOutputFormat(normalizedOutputFormat)) {
    throw new UnsupportedFormatError(normalizedOutputFormat);
  }

  // Generate output path
  const inputDir = path.dirname(inputPath);
  const outputFilename = generateOutputFilename(path.basename(inputPath), normalizedOutputFormat);
  const outputPath = path.join(inputDir, outputFilename);

  // Same format - just copy
  if (inputFormat === normalizedOutputFormat) {
    await fs.copy(inputPath, outputPath);
    return {
      outputPath,
      tool: 'assimp', // No conversion needed
      duration: Date.now() - startTime
    };
  }

  let tool: ConversionResult['tool'];

  // =====================================================
  // 1. DWG INPUT - Always convert to DXF first via ODA
  // =====================================================
  if (isDwgFormat(inputFormat)) {
    console.log(`[ConversionService] DWG input detected, using ODA pipeline`);
    
    if (normalizedOutputFormat === 'dxf') {
      // Direct DWG → DXF via ODA
      const odaResultPath = await odaConvert(inputPath, 'DXF');
      // Rename to expected output path if different
      if (odaResultPath !== outputPath) {
        await fs.move(odaResultPath, outputPath, { overwrite: true });
      }
      tool = 'oda';
    } else {
      // DWG → DXF → target (with FreeCAD fallback for 3D solids)
      const tempDxfPath = await dwgToDxf(inputPath);
      try {
        await convertDxfToTarget(tempDxfPath, outputPath, inputDir, normalizedOutputFormat);
      } finally {
        // Cleanup temp DXF
        await fs.remove(tempDxfPath).catch(() => {});
      }
      tool = 'pipeline';
    }
    
    return {
      outputPath,
      tool,
      duration: Date.now() - startTime
    };
  }

  // =====================================================
  // 2. DWG OUTPUT - Convert to DXF first, then to DWG
  // =====================================================
  if (isDwgFormat(normalizedOutputFormat)) {
    console.log(`[ConversionService] DWG output requested, using ODA pipeline`);
    
    if (inputFormat === 'dxf') {
      // Direct DXF → DWG via ODA
      const odaResultPath = await odaConvert(inputPath, 'DWG');
      // Rename to expected output path if different
      if (odaResultPath !== outputPath) {
        await fs.move(odaResultPath, outputPath, { overwrite: true });
      }
      tool = 'oda';
    } else {
      // Source → DXF → DWG
      const tempDxfPath = path.join(inputDir, `temp_${Date.now()}.dxf`);
      try {
        await blenderConvert(inputPath, tempDxfPath);
        const odaResultPath = await odaConvert(tempDxfPath, 'DWG');
        
        // Rename the ODA output to expected output path
        await fs.move(odaResultPath, outputPath, { overwrite: true });
      } finally {
        // Cleanup temp DXF
        await fs.remove(tempDxfPath).catch(() => {});
      }
      tool = 'pipeline';
    }
    
    return {
      outputPath,
      tool,
      duration: Date.now() - startTime
    };
  }

  // =====================================================
  // 3. BINARY DXF INPUT - Convert to ASCII DXF via ODA first
  // =====================================================
  if (isDxfFile(inputPath) && isBinaryDxf(inputPath)) {
    console.log(`[ConversionService] Binary DXF detected, converting to ASCII via ODA first...`);
    
    let asciiDxfPath: string | null = null;
    try {
      // Convert binary DXF to ASCII DXF via ODA
      asciiDxfPath = await binaryDxfToAscii(inputPath);
      
      // Now convert the ASCII DXF to the target format
      if (normalizedOutputFormat === 'dxf') {
        // If target is DXF, just use the converted ASCII file
        await fs.move(asciiDxfPath, outputPath, { overwrite: true });
        return {
          outputPath,
          tool: 'oda',
          duration: Date.now() - startTime
        };
      } else {
        // Convert ASCII DXF to target format via Blender/FreeCAD
        await convertDxfToTarget(asciiDxfPath, outputPath, inputDir, normalizedOutputFormat);
        return {
          outputPath,
          tool: 'pipeline', // ODA + Blender/FreeCAD
          duration: Date.now() - startTime
        };
      }
    } finally {
      // Cleanup temp ASCII DXF if it wasn't moved to output
      if (asciiDxfPath && await fs.pathExists(asciiDxfPath)) {
        await fs.remove(asciiDxfPath).catch(() => {});
      }
    }
  }

  // =====================================================
  // 4. CAD FORMAT (DXF) - Try Blender, fallback to FreeCAD, then APS
  // =====================================================
  if (isCadFormat(inputFormat) || isCadFormat(normalizedOutputFormat)) {
    console.log(`[ConversionService] CAD format detected, trying Blender first...`);
    // Cast for type safety - output format might be obj/stl even when input is CAD
    const outFmt = normalizedOutputFormat as string;
    
    try {
      await blenderConvert(inputPath, outputPath);
      return {
        outputPath,
        tool: 'blender',
        duration: Date.now() - startTime
      };
    } catch (blenderErr) {
      console.log(`[ConversionService] Blender failed (likely 3D solids), trying FreeCAD...`);
      
      // FreeCAD can handle ACIS 3D solids that Blender cannot
      if (canFreecadHandle(inputFormat)) {
        // FreeCAD outputs to mesh format (STL), then convert to final format
        const tempStlPath = path.join(inputDir, `temp_${Date.now()}.stl`);
        try {
          const freecadResult = await convertWithFreecad(inputPath, 'stl');
          
          // Convert STL to final format using Assimp/Blender
          await fs.move(freecadResult.outputPath, tempStlPath, { overwrite: true });
          await convertWithFallback(tempStlPath, outputPath);
          
          return {
            outputPath,
            tool: 'pipeline', // FreeCAD + Assimp/Blender
            duration: Date.now() - startTime
          };
        } catch (freecadErr) {
          console.log(`[ConversionService] FreeCAD also failed, trying Autodesk APS...`);
          
          // Try Autodesk APS as ultimate fallback for ACIS 3D solids
          if (isApsAvailable() && (outFmt === 'obj' || outFmt === 'stl')) {
            try {
              // APS supports direct conversion to OBJ/STL
              await apsConvert(inputPath, outputPath, { 
                outputFormat: outFmt as 'obj' | 'stl' 
              });
              
              return {
                outputPath,
                tool: 'aps',
                duration: Date.now() - startTime
              };
            } catch (apsErr) {
              console.log(`[ConversionService] Autodesk APS also failed`);
              console.error(apsErr);
            }
          }
          
          // All options exhausted - provide informative error
          throw new ConversionError(
            'DXF file contains 3DSOLID (ACIS) entities that cannot be converted',
            'This file contains proprietary ACIS/SAT 3D solid geometry. ' +
            (isApsAvailable() 
              ? 'Autodesk APS conversion also failed. '
              : 'Configure APS_CLIENT_ID and APS_CLIENT_SECRET for Autodesk cloud conversion. ') +
            'Alternative solutions: (1) Export from original CAD software as STEP, IGES, ' +
            'or mesh format (STL/OBJ), (2) Use AutoCAD to explode/mesh the solids before exporting.'
          );
        } finally {
          await fs.remove(tempStlPath).catch(() => {});
        }
      }
      
      // FreeCAD can't handle it, try APS directly
      if (isApsAvailable() && (outFmt === 'obj' || outFmt === 'stl')) {
        console.log(`[ConversionService] Trying Autodesk APS directly...`);
        try {
          await apsConvert(inputPath, outputPath, { 
            outputFormat: outFmt as 'obj' | 'stl' 
          });
          
          return {
            outputPath,
            tool: 'aps',
            duration: Date.now() - startTime
          };
        } catch (apsErr) {
          console.log(`[ConversionService] Autodesk APS failed`);
          console.error(apsErr);
        }
      }
      
      // Re-throw if nothing can handle it
      throw blenderErr;
    }
  }

  // =====================================================
  // 5. SIMPLE MESH - Try Assimp first, fallback to Blender
  // =====================================================
  tool = await convertWithFallback(inputPath, outputPath);
  
  return {
    outputPath,
    tool,
    duration: Date.now() - startTime
  };
}

/**
 * Convert DXF to target format with FreeCAD/APS fallback for 3D solids
 */
async function convertDxfToTarget(
  dxfPath: string,
  outputPath: string,
  workDir: string,
  outputFormat: string
): Promise<void> {
  try {
    // Try Blender first (works for DXF with lines/polylines)
    console.log(`[ConversionService] Trying Blender for DXF conversion...`);
    await blenderConvert(dxfPath, outputPath);
  } catch (blenderErr) {
    console.log(`[ConversionService] Blender failed (likely 3D solids), trying FreeCAD...`);
    
    // FreeCAD fallback for ACIS 3D solids
    if (canFreecadHandle('dxf')) {
      const tempStlPath = path.join(workDir, `temp_${Date.now()}.stl`);
      try {
        const freecadResult = await convertWithFreecad(dxfPath, 'stl');
        
        if (outputFormat === 'stl') {
          await fs.move(freecadResult.outputPath, outputPath, { overwrite: true });
        } else {
          // Convert STL to final format
          await fs.move(freecadResult.outputPath, tempStlPath, { overwrite: true });
          await convertWithFallback(tempStlPath, outputPath);
        }
      } catch (freecadErr) {
        console.log(`[ConversionService] FreeCAD also failed, trying Autodesk APS...`);
        
        // Try Autodesk APS as final fallback
        if (isApsAvailable() && (outputFormat === 'obj' || outputFormat === 'stl')) {
          try {
            await apsConvert(dxfPath, outputPath, { 
              outputFormat: outputFormat as 'obj' | 'stl' 
            });
            return; // Success with APS
          } catch (apsErr) {
            console.log(`[ConversionService] Autodesk APS also failed`);
            console.error(apsErr);
          }
        }
        
        // All options failed
        throw new ConversionError(
          'DXF file contains 3DSOLID (ACIS) entities that cannot be converted',
          'This file contains proprietary ACIS/SAT 3D solid geometry. ' +
          (isApsAvailable() 
            ? 'Autodesk APS conversion also failed. '
            : 'Configure APS_CLIENT_ID and APS_CLIENT_SECRET for Autodesk cloud conversion. ') +
          'Alternative solutions: (1) Export from original CAD software as STEP, IGES, ' +
          'or mesh format (STL/OBJ), (2) Use AutoCAD to explode/mesh the solids before exporting.'
        );
      } finally {
        await fs.remove(tempStlPath).catch(() => {});
      }
    } else {
      // FreeCAD can't handle this format, try APS directly
      if (isApsAvailable() && (outputFormat === 'obj' || outputFormat === 'stl')) {
        console.log(`[ConversionService] Trying Autodesk APS directly...`);
        try {
          await apsConvert(dxfPath, outputPath, { 
            outputFormat: outputFormat as 'obj' | 'stl' 
          });
          return; // Success with APS
        } catch (apsErr) {
          console.log(`[ConversionService] Autodesk APS failed`);
          console.error(apsErr);
        }
      }
      
      throw blenderErr;
    }
  }
}

/**
 * Try Assimp first for simple meshes, fallback to Blender on failure
 */
async function convertWithFallback(
  inputPath: string,
  outputPath: string
): Promise<'assimp' | 'blender'> {
  const inputFormat = getExtension(inputPath);
  const outputFormat = getExtension(outputPath);

  // Only try Assimp for simple mesh conversions
  if (isSimpleMesh(inputFormat) && isSimpleMesh(outputFormat)) {
    try {      console.log(`[ConversionService] Trying Assimp first...`);
      await assimpConvert(inputPath, outputPath);
      return 'assimp';
    } catch (err) {
      console.log(`[ConversionService] Assimp failed, falling back to Blender`);
      console.error(err);
    }
  }

  // Fallback to Blender
  console.log(`[ConversionService] Using Blender`);
  await blenderConvert(inputPath, outputPath);
  return 'blender';
}