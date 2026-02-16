/**
 * Application constants
 */

// Supported file formats
export const SUPPORTED_INPUT_FORMATS = ['obj', 'stl', 'fbx', 'ply', 'gltf', 'glb', 'dae', '3ds', 'dxf', 'dwg', 'step', 'stp', 'iges', 'igs', 'ifc'] as const;
export const SUPPORTED_OUTPUT_FORMATS = ['obj', 'stl', 'fbx', 'ply', 'gltf', 'glb', 'dae', '3ds', 'dxf', 'dwg', 'step', 'stp', 'iges', 'igs', 'ifc'] as const;

// Format categories for routing decisions
export const SIMPLE_MESH_FORMATS = ['obj', 'stl', 'fbx', 'ply', 'glb', 'gltf', 'dae', '3ds'] as const;
export const CAD_FORMATS = ['dxf', 'dwg', 'step', 'iges', 'stp', 'igs', 'ifc'] as const;

// STEP/IGES formats (B-Rep CAD formats handled by FreeCAD)
export const STEP_FORMATS = ['step', 'stp'] as const;
export const IGES_FORMATS = ['iges', 'igs'] as const;
export const BREP_CAD_FORMATS = ['step', 'stp', 'iges', 'igs'] as const;

// IFC format (BIM format handled by IfcOpenShell)
export const IFC_FORMATS = ['ifc'] as const;

// File size limits
export const MAX_FILE_SIZE_MB = 100;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Paths (inside Docker container)
export const BLENDER_SCRIPT_PATH = '/usr/src/app/scripts/blender/export.py';
export const ODA_CONVERTER_PATH = '/usr/bin/ODAFileConverter';

// MIME types for 3D files
export const MIME_TYPES: Record<string, string> = {
  obj: 'model/obj',
  stl: 'model/stl',
  fbx: 'application/octet-stream',
  ply: 'application/x-ply',
  gltf: 'model/gltf+json',
  glb: 'model/gltf-binary',
  dae: 'model/vnd.collada+xml',
  '3ds': 'application/x-3ds',
  dxf: 'application/dxf',
  dwg: 'application/acad',
  step: 'application/step',
  stp: 'application/step',
  iges: 'application/iges',
  igs: 'application/iges',
  ifc: 'application/x-ifc',
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

/**
 * Check if a format is IFC (BIM format)
 */
export function isIfcFormat(format: string): boolean {
  return IFC_FORMATS.includes(format.toLowerCase() as typeof IFC_FORMATS[number]);
}
