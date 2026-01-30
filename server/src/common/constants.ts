/**
 * Application constants
 */

// Supported file formats
export const SUPPORTED_INPUT_FORMATS = ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'] as const;
export const SUPPORTED_OUTPUT_FORMATS = ['obj', 'fbx', 'gltf', 'glb', 'dxf', 'dwg'] as const;

// Format categories for routing decisions
export const SIMPLE_MESH_FORMATS = ['obj', 'stl', 'ply', 'glb', 'gltf'] as const;
export const CAD_FORMATS = ['dxf', 'dwg'] as const;

// File size limits
export const MAX_FILE_SIZE_MB = 100;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Paths (inside Docker container)
export const BLENDER_SCRIPT_PATH = '/usr/src/app/scripts/blender/export.py';
export const ODA_CONVERTER_PATH = '/usr/bin/ODAFileConverter';

// MIME types for 3D files
export const MIME_TYPES: Record<string, string> = {
  obj: 'model/obj',
  fbx: 'application/octet-stream',
  gltf: 'model/gltf+json',
  glb: 'model/gltf-binary',
  dxf: 'application/dxf',
  dwg: 'application/acad',
};

// TypeScript types
export type InputFormat = typeof SUPPORTED_INPUT_FORMATS[number];
export type OutputFormat = typeof SUPPORTED_OUTPUT_FORMATS[number];

/**
 * Check if a format is supported for input
 */
export function isSupportedInputFormat(format: string): format is InputFormat {
  return SUPPORTED_INPUT_FORMATS.includes(format.toLowerCase() as InputFormat);
}

/**
 * Check if a format is supported for output
 */
export function isSupportedOutputFormat(format: string): format is OutputFormat {
  return SUPPORTED_OUTPUT_FORMATS.includes(format.toLowerCase() as OutputFormat);
}
