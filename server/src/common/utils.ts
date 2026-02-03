/**
 * Utility functions
 */

import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { SIMPLE_MESH_FORMATS, CAD_FORMATS } from './constants';

/**
 * Get file extension without dot, lowercase
 */
export function getExtension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * Generate unique filename with timestamp and random suffix
 */
export function generateUniqueFilename(originalName: string): string {
  const ext = path.extname(originalName);
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `${timestamp}-${random}${ext}`;
}

/**
 * Generate output filename from input filename and target format
 */
export function generateOutputFilename(inputFilename: string, outputFormat: string): string {
  const baseName = path.basename(inputFilename, path.extname(inputFilename));
  return `${baseName}.${outputFormat.toLowerCase()}`;
}

/**
 * Check if format is a simple mesh (Assimp can handle)
 */
export function isSimpleMesh(format: string): boolean {
  return (SIMPLE_MESH_FORMATS as readonly string[]).includes(format.toLowerCase());
}

/**
 * Check if format is CAD (requires Blender or ODA)
 */
export function isCadFormat(format: string): boolean {
  return (CAD_FORMATS as readonly string[]).includes(format.toLowerCase());
}

/**
 * Check if format is DWG (requires ODA converter)
 */
export function isDwgFormat(format: string): boolean {
  return format.toLowerCase() === 'dwg';
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sanitize filename to prevent path traversal
 */
export function sanitizeFilename(filename: string): string {
  // Remove any path components and keep only the filename
  const baseName = path.basename(filename);
  // Remove any characters that could be problematic
  return baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Check if a DXF file is in binary format
 * Binary DXF files start with "AutoCAD Binary DXF" header
 * ASCII DXF files start with whitespace and "0"
 * 
 * @param filePath - Path to the DXF file
 * @returns true if binary DXF, false if ASCII DXF
 */
export function isBinaryDxf(filePath: string): boolean {
  const BINARY_DXF_HEADER = 'AutoCAD Binary DXF';
  
  try {
    // Read only the first 22 bytes to check header
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(22);
    fs.readSync(fd, buffer, 0, 22, 0);
    fs.closeSync(fd);
    
    // Check for binary DXF signature
    const header = buffer.toString('ascii');
    return header.includes(BINARY_DXF_HEADER);
  } catch (error) {
    console.error(`[utils] Error checking DXF format: ${error}`);
    return false; // Assume ASCII if can't read
  }
}

/**
 * Check if file is a DXF file
 */
export function isDxfFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.dxf';
}
