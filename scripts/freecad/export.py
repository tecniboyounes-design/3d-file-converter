#!/usr/bin/env python3
"""
FreeCAD Export Script - Converts CAD files with 3D solids to mesh formats

This script is called by the Node.js backend to convert DXF/STEP/IGES files
containing ACIS 3D solids to mesh-based formats (STL, OBJ).

Usage:
    freecad-convert export.py

Environment Variables:
    INPUT_FILE_PATH: Path to input file
    OUTPUT_FILE_PATH: Path to output file
"""

import sys
import os

# Add FreeCAD library paths for Debian package
freecad_paths = [
    '/usr/lib/freecad/lib',
    '/usr/share/freecad/Mod/Draft',  # For importDXF
    '/usr/share/freecad/Mod/Part',
    '/usr/share/freecad/Mod/Mesh',
    '/usr/share/freecad/Ext',
]
for p in freecad_paths:
    if os.path.exists(p) and p not in sys.path:
        sys.path.insert(0, p)

# FreeCAD modules
import FreeCAD
import Part
import Mesh
import importDXF

def main():
    input_path = os.environ.get("INPUT_FILE_PATH")
    output_path = os.environ.get("OUTPUT_FILE_PATH")
    
    if not input_path or not output_path:
        print("[FreeCAD] ERROR: INPUT_FILE_PATH and OUTPUT_FILE_PATH required")
        sys.exit(1)
    
    input_ext = os.path.splitext(input_path)[1].lower()
    output_ext = os.path.splitext(output_path)[1].lower()
    
    print(f"[FreeCAD] Converting: {input_ext} → {output_ext}")
    print(f"[FreeCAD] Input: {input_path}")
    print(f"[FreeCAD] Output: {output_path}")
    
    # Create new document
    doc = FreeCAD.newDocument("Conversion")
    
    try:
        # Import based on file type
        if input_ext == ".dxf":
            importDXF.open(input_path)
        elif input_ext in (".step", ".stp"):
            Part.insert(input_path, doc.Name)
        elif input_ext in (".iges", ".igs"):
            Part.insert(input_path, doc.Name)
        elif input_ext == ".brep":
            Part.insert(input_path, doc.Name)
        else:
            print(f"[FreeCAD] ERROR: Unsupported input format: {input_ext}")
            sys.exit(1)
        
        # Get all documents (importDXF.open may create a new one)
        doc = FreeCAD.ActiveDocument
        if doc is None:
            print("[FreeCAD] ERROR: No document created")
            sys.exit(1)
        
        # Collect all shapes
        shapes = []
        for obj in doc.Objects:
            if hasattr(obj, "Shape") and obj.Shape:
                shapes.append(obj.Shape)
        
        if not shapes:
            print("[FreeCAD] ERROR: No shapes found in document")
            sys.exit(1)
        
        print(f"[FreeCAD] Found {len(shapes)} shapes")
        
        # Combine all shapes
        if len(shapes) == 1:
            combined = shapes[0]
        else:
            combined = shapes[0]
            for shape in shapes[1:]:
                try:
                    combined = combined.fuse(shape)
                except:
                    # If fusion fails, just add to compound
                    combined = Part.makeCompound([combined, shape])
        
        # Tesselate to mesh
        print("[FreeCAD] Tessellating to mesh...")
        mesh = Mesh.Mesh()
        
        # Use tessellation with reasonable precision
        # LinearDeflection controls the accuracy (smaller = more polygons)
        tessellation = combined.tessellate(0.1)
        
        if tessellation and len(tessellation[0]) > 0:
            vertices = tessellation[0]
            faces = tessellation[1]
            
            # Build mesh from tessellation
            for face in faces:
                if len(face) >= 3:
                    v1 = vertices[face[0]]
                    v2 = vertices[face[1]]
                    v3 = vertices[face[2]]
                    mesh.addFacet(v1[0], v1[1], v1[2],
                                  v2[0], v2[1], v2[2],
                                  v3[0], v3[1], v3[2])
        else:
            print("[FreeCAD] Warning: Direct tessellation failed, trying mesh export...")
            # Fallback: try to get mesh from shape directly
            mesh = FreeCAD.ActiveDocument.addObject("Mesh::Feature", "Mesh")
            mesh.Mesh = Mesh.Mesh(combined.tessellate(0.1))
        
        print(f"[FreeCAD] Mesh has {mesh.CountPoints} vertices, {mesh.CountFacets} faces")
        
        if mesh.CountFacets == 0:
            print("[FreeCAD] ERROR: No mesh faces generated")
            sys.exit(1)
        
        # Export mesh
        if output_ext == ".stl":
            mesh.write(output_path)
        elif output_ext == ".obj":
            mesh.write(output_path)
        elif output_ext == ".ply":
            mesh.write(output_path)
        else:
            # Default to STL
            mesh.write(output_path)
        
        # Verify output
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            print(f"[FreeCAD] SUCCESS: Output written to {output_path}")
            print(f"[FreeCAD] Output size: {os.path.getsize(output_path)} bytes")
        else:
            print("[FreeCAD] ERROR: Output file not created or empty")
            sys.exit(1)
            
    except Exception as e:
        print(f"[FreeCAD] ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        FreeCAD.closeDocument(doc.Name)

if __name__ == "__main__":
    main()
