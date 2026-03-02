#!/usr/bin/env python3
"""
FreeCAD Mesh-to-STEP Converter

Converts STL mesh to STEP solid with quality optimization.
This script implements the "FreeCAD Bridge Method" for mesh → B-Rep conversion.

Pipeline:
1. Load STL mesh
2. Check if mesh is watertight (solid)
3. Repair mesh if needed (fill holes, fix intersections)
4. Convert mesh to Part.Shape using makeShapeFromMesh()
5. Refine shape with removeSplitter() (merge coplanar faces)
6. Convert to Solid with Part.Solid()
7. Export as STEP

Environment Variables:
    INPUT_FILE_PATH: Path to input STL file
    OUTPUT_FILE_PATH: Path to output STEP file
"""

import sys
import os

# Add FreeCAD library paths for Debian package
freecad_paths = [
    '/usr/lib/freecad/lib',
    '/usr/share/freecad/Mod/Part',
    '/usr/share/freecad/Mod/Mesh',
    '/usr/share/freecad/Mod/MeshPart',
    '/usr/share/freecad/Ext',
]
for p in freecad_paths:
    if os.path.exists(p) and p not in sys.path:
        sys.path.insert(0, p)

import FreeCAD
import Part
import Mesh


def repair_mesh(mesh_obj, aggressive=False):
    """
    Attempt to repair a mesh - with option for gentle or aggressive repair.
    
    Args:
        mesh_obj: FreeCAD Mesh object
        aggressive: If False, only do minimal non-destructive repairs
        
    Returns:
        bool: True if repair was successful or mesh is already solid
    """
    was_solid = mesh_obj.isSolid()
    original_facets = mesh_obj.CountFacets
    
    if was_solid:
        print("[FreeCAD] Mesh is already watertight ✓")
        return True
    
    print("[FreeCAD] Mesh is not watertight, attempting gentle repair...")
    
    # Step 1: Remove only exact duplicate points (non-destructive)
    mesh_obj.removeDuplicatedPoints()
    
    # Step 2: Remove exact duplicate facets (non-destructive)
    mesh_obj.removeDuplicatedFacets()
    
    # Step 3: Harmonize normals (non-destructive, just flips directions)
    mesh_obj.harmonizeNormals()
    
    current_facets = mesh_obj.CountFacets
    
    if aggressive:
        print("[FreeCAD] Applying aggressive repair (may lose geometry)...")
        # These can remove geometry:
        mesh_obj.fixSelfIntersections()
        mesh_obj.fillupHoles(1000)  # Smaller holes only
        mesh_obj.removeNonManifolds()
    
    # Check result
    is_solid_now = mesh_obj.isSolid()
    final_facets = mesh_obj.CountFacets
    
    if is_solid_now:
        print(f"[FreeCAD] Repair successful - mesh is now watertight ✓")
    else:
        print(f"[FreeCAD] Mesh still has openings, but preserving geometry")
    
    if final_facets != original_facets:
        print(f"[FreeCAD] Facets: {original_facets} → {final_facets} ({final_facets - original_facets:+d})")
    else:
        print(f"[FreeCAD] Facets preserved: {final_facets}")
    
    return is_solid_now


def decimate_mesh(mesh_obj, target_faces=50000):
    """
    Decimate a mesh to reduce face count for memory-safe STEP conversion.

    Args:
        mesh_obj: FreeCAD Mesh object
        target_faces: Target number of faces after decimation

    Returns:
        Mesh.Mesh: Decimated mesh (or original if already small enough)
    """
    face_count = mesh_obj.CountFacets
    if face_count <= target_faces:
        return mesh_obj

    ratio = target_faces / face_count
    print(f"[FreeCAD] Decimating mesh: {face_count} → ~{target_faces} faces (ratio={ratio:.3f})...")

    try:
        mesh_obj.decimate(tolerance=0.0, reduction=ratio)
        print(f"[FreeCAD] Decimated: {mesh_obj.CountFacets} faces")
    except Exception as e:
        print(f"[FreeCAD] Decimation failed: {e}, using original mesh")

    return mesh_obj


def mesh_to_shape(mesh_obj, tolerance=0.001):
    """
    Convert a mesh to a Part.Shape using FreeCAD's OpenCASCADE kernel.

    Args:
        mesh_obj: FreeCAD Mesh object
        tolerance: Tolerance for shape creation (smaller = more accurate)
                   Default 0.001mm for high precision

    Returns:
        Part.Shape: The converted shape
    """
    face_count = mesh_obj.CountFacets

    # For large meshes, use a larger tolerance to reduce memory usage
    if face_count > 50000:
        tolerance = max(tolerance, 0.1)
        print(f"[FreeCAD] Large mesh ({face_count} faces), using tolerance={tolerance}")

    print(f"[FreeCAD] Converting mesh to shape (tolerance={tolerance})...")

    # Get mesh topology (vertices and faces)
    topology = mesh_obj.Topology

    # Create shape from mesh topology
    shape = Part.Shape()
    shape.makeShapeFromMesh(topology, tolerance)

    print(f"[FreeCAD] Shape created: {len(shape.Faces)} faces, {len(shape.Edges)} edges")

    return shape


def refine_shape(shape, merge_faces=False):
    """
    Optionally refine shape by merging coplanar faces.
    
    Args:
        shape: Part.Shape to refine
        merge_faces: If True, merge coplanar faces (reduces detail but cleaner CAD)
        
    Returns:
        Part.Shape: Refined or original shape
    """
    if not merge_faces:
        print("[FreeCAD] Skipping face merging to preserve geometry")
        return shape
    
    print("[FreeCAD] Refining shape (merging coplanar faces)...")
    
    try:
        refined = shape.removeSplitter()
        print(f"[FreeCAD] Refined shape: {len(refined.Faces)} faces (was {len(shape.Faces)})")
        return refined
    except Exception as e:
        print(f"[FreeCAD] Warning: removeSplitter() failed: {e}")
        print("[FreeCAD] Using original shape...")
        return shape


def shape_to_solid(shape):
    """
    Convert a shape to a solid (required for valid STEP export).
    
    Args:
        shape: Part.Shape (should be a shell or compound of faces)
        
    Returns:
        Part.Solid or Part.Shape: Solid if possible, otherwise the best available shape
    """
    print("[FreeCAD] Converting to solid...")
    
    # Check if we have faces to work with
    if not shape.Faces:
        print("[FreeCAD] ERROR: Shape has no faces!")
        return shape
    
    print(f"[FreeCAD] Shape has {len(shape.Faces)} faces to process")
    
    # First try to make a shell from all faces
    try:
        # Create a compound from all faces first
        if shape.ShapeType == 'Compound':
            faces = shape.Faces
        else:
            faces = shape.Faces
        
        print(f"[FreeCAD] Creating shell from {len(faces)} faces...")
        shell = Part.makeShell(faces)
        
        # Now try to make solid from shell
        if shell.isClosed():
            solid = Part.Solid(shell)
            print(f"[FreeCAD] Created solid successfully ✓")
            print(f"[FreeCAD] Volume: {solid.Volume:.4f} cubic units")
            return solid
        else:
            print("[FreeCAD] Shell is not closed, exporting as compound of faces...")
            # Create a compound of all faces - this will preserve the geometry
            compound = Part.makeCompound(faces)
            print(f"[FreeCAD] Created compound with {len(compound.Faces)} faces")
            return compound
            
    except Exception as e:
        print(f"[FreeCAD] Could not create shell/solid: {e}")
        # Fallback: create compound of faces directly from the shape
        try:
            print("[FreeCAD] Fallback: creating compound from faces...")
            compound = Part.makeCompound(shape.Faces)
            print(f"[FreeCAD] Created compound with {len(compound.Faces)} faces")
            return compound
        except Exception as e2:
            print(f"[FreeCAD] Fallback also failed: {e2}")
            print("[FreeCAD] Exporting original shape...")
            return shape


def main():
    input_path = os.environ.get("INPUT_FILE_PATH")
    output_path = os.environ.get("OUTPUT_FILE_PATH")
    
    if not input_path or not output_path:
        print("[FreeCAD] ERROR: INPUT_FILE_PATH and OUTPUT_FILE_PATH required")
        sys.exit(1)
    
    print(f"[FreeCAD] ════════════════════════════════════════════════════════")
    print(f"[FreeCAD] Mesh-to-STEP Conversion")
    print(f"[FreeCAD] ════════════════════════════════════════════════════════")
    print(f"[FreeCAD] Input:  {input_path}")
    print(f"[FreeCAD] Output: {output_path}")
    print(f"[FreeCAD] ════════════════════════════════════════════════════════")
    
    try:
        # 1. Load the mesh
        print("[FreeCAD] Loading mesh...")
        mesh_obj = Mesh.Mesh(input_path)
        original_faces = mesh_obj.CountFacets
        print(f"[FreeCAD] Loaded: {mesh_obj.CountPoints} vertices, {original_faces} faces")
        
        if mesh_obj.CountFacets == 0:
            print("[FreeCAD] ERROR: Mesh has no faces")
            sys.exit(1)
        
        # 2. Gentle repair only (preserve geometry)
        repair_mesh(mesh_obj, aggressive=False)

        # 2.5. Decimate large meshes to prevent OOM during shape creation
        mesh_obj = decimate_mesh(mesh_obj, target_faces=50000)

        # 3. Convert mesh to shape
        shape = mesh_to_shape(mesh_obj, tolerance=0.001)
        
        # 4. Skip face merging to preserve all geometry
        refined_shape = refine_shape(shape, merge_faces=False)
        
        # 5. Convert to solid/compound
        solid = shape_to_solid(refined_shape)
        
        # 6. Export as STEP
        print("[FreeCAD] Exporting STEP file...")
        print(f"[FreeCAD] Exporting shape type: {solid.ShapeType}")
        print(f"[FreeCAD] Faces to export: {len(solid.Faces)}")
        
        if len(solid.Faces) == 0:
            print("[FreeCAD] ERROR: No faces to export!")
            sys.exit(1)
        
        # Report quality
        final_faces = len(solid.Faces)
        quality_pct = (final_faces / original_faces) * 100 if original_faces > 0 else 0
        print(f"[FreeCAD] Quality: {final_faces}/{original_faces} faces preserved ({quality_pct:.1f}%)")
        
        # Use exportStep() method directly - Part.export() doesn't work properly in FreeCAD 0.20
        solid.exportStep(output_path)
        
        # 7. Verify output - check file size and content
        if os.path.exists(output_path):
            output_size = os.path.getsize(output_path)
            
            # A valid STEP with geometry should be > 2KB typically
            if output_size < 2000:
                # Check if file contains actual geometry by looking for FACE entities
                with open(output_path, 'r') as f:
                    content = f.read()
                    if 'ADVANCED_FACE' not in content and 'B_SPLINE' not in content and 'FACE_SURFACE' not in content:
                        print("[FreeCAD] WARNING: STEP file may be missing geometry!")
                        print(f"[FreeCAD] File size: {output_size} bytes (expected > 2KB for geometry)")
            
            print(f"[FreeCAD] ════════════════════════════════════════════════════════")
            print(f"[FreeCAD] SUCCESS")
            print(f"[FreeCAD] Output: {output_path}")
            print(f"[FreeCAD] Size:   {output_size} bytes ({output_size / 1024:.1f} KB)")
            print(f"[FreeCAD] Faces:  {len(solid.Faces)}")
            print(f"[FreeCAD] ════════════════════════════════════════════════════════")
        else:
            print("[FreeCAD] ERROR: Output file not created or empty")
            sys.exit(1)
            
    except Exception as e:
        print(f"[FreeCAD] ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
