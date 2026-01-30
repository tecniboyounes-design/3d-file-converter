/**
 * Conversion Service - Smart routing between conversion tools
 * 
 * Decision Matrix:
 * - Simple mesh (OBJ, STL, PLY, GLB, GLTF): Try Assimp first, fallback to Blender
 * - CAD formats (DXF): Use Blender
 * - DWG input: ODA → DXF → target via Blender/Assimp
 * - DWG output: Source → DXF via Blender → DWG via ODA
 */

import path from 'path';
import fs from 'fs-extra';
import { 
  blenderConvert, 
  assimpConvert, 
  odaConvert, 
  dwgToDxf 
} from './providers';
import { 
  isSimpleMesh, 
  isCadFormat, 
  isDwgFormat, 
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
  tool: 'assimp' | 'blender' | 'oda' | 'pipeline';
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
      // DWG → DXF → target
      const tempDxfPath = await dwgToDxf(inputPath);
      try {
        await convertWithFallback(tempDxfPath, outputPath);
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
  // 3. CAD FORMAT (DXF) - Requires Blender
  // =====================================================
  if (isCadFormat(inputFormat) || isCadFormat(normalizedOutputFormat)) {
    console.log(`[ConversionService] CAD format detected, using Blender`);
    await blenderConvert(inputPath, outputPath);
    return {
      outputPath,
      tool: 'blender',
      duration: Date.now() - startTime
    };
  }

  // =====================================================
  // 4. SIMPLE MESH - Try Assimp first, fallback to Blender
  // =====================================================
  tool = await convertWithFallback(inputPath, outputPath);
  
  return {
    outputPath,
    tool,
    duration: Date.now() - startTime
  };
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
    try {
      console.log(`[ConversionService] Trying Assimp first...`);
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
