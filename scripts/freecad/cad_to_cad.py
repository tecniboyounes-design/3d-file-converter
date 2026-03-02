#!/usr/bin/env python3
"""
FreeCAD CAD-to-CAD Converter

Converts between CAD formats (STEP, IGES, DXF, BREP) using FreeCAD's 
OpenCASCADE kernel for high-quality B-Rep preservation.

Supported Conversions:
    STEP → IGES, DXF, BREP
    IGES → STEP, DXF, BREP
    DXF  → STEP, IGES (if contains 3D solids)
    BREP → STEP, IGES, DXF

Environment Variables:
    INPUT_FILE_PATH: Path to input CAD file
    OUTPUT_FILE_PATH: Path to output CAD file
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

import FreeCAD
import Part
import importDXF


def load_cad_file(file_path, doc):
    """
    Load a CAD file into the FreeCAD document.
    
    Args:
        file_path: Path to the CAD file
        doc: FreeCAD document to load into
        
    Returns:
        list: List of shapes found in the file
    """
    ext = os.path.splitext(file_path)[1].lower()
    
    print(f"[FreeCAD] Loading {ext.upper()} file...")
    
    if ext == ".dxf":
        # DXF requires special importer
        importDXF.open(file_path)
        # importDXF.open creates a new document, get the active one
        doc = FreeCAD.ActiveDocument
    elif ext in (".step", ".stp"):
        Part.insert(file_path, doc.Name)
    elif ext in (".iges", ".igs"):
        # Try Part.insert first, fall back to Part.open and direct shape read
        Part.insert(file_path, doc.Name)
    elif ext == ".brep":
        Part.insert(file_path, doc.Name)
    else:
        raise ValueError(f"Unsupported input format: {ext}")

    # Get active document (may have changed)
    doc = FreeCAD.ActiveDocument
    if doc is None:
        raise RuntimeError("No document created after import")

    # Collect all shapes
    shapes = []
    for obj in doc.Objects:
        if hasattr(obj, "Shape") and obj.Shape:
            if not obj.Shape.isNull():
                shapes.append(obj.Shape)

    # For IGES: if Part.insert found no shapes, try reading the shape directly
    if not shapes and ext in (".iges", ".igs"):
        print(f"[FreeCAD] Part.insert found no shapes, trying direct Part.Shape.read...")
        try:
            shape = Part.Shape()
            shape.read(file_path)
            if not shape.isNull():
                shapes.append(shape)
                print(f"[FreeCAD] Direct shape read succeeded")
        except Exception as e:
            print(f"[FreeCAD] Direct shape read failed: {e}")

        # If still no shapes, try Part.open (creates new document)
        if not shapes:
            print(f"[FreeCAD] Trying Part.open...")
            try:
                Part.open(file_path)
                doc = FreeCAD.ActiveDocument
                for obj in doc.Objects:
                    if hasattr(obj, "Shape") and obj.Shape:
                        if not obj.Shape.isNull():
                            shapes.append(obj.Shape)
            except Exception as e:
                print(f"[FreeCAD] Part.open failed: {e}")

    if not shapes:
        raise RuntimeError("No shapes found in document")
    
    print(f"[FreeCAD] Loaded {len(shapes)} shape(s)")
    
    return shapes, doc


def combine_shapes(shapes):
    """
    Combine multiple shapes into a single compound.
    
    Args:
        shapes: List of Part.Shape objects
        
    Returns:
        Part.Shape: Combined shape
    """
    if len(shapes) == 1:
        return shapes[0]
    
    print(f"[FreeCAD] Combining {len(shapes)} shapes...")
    
    # Try to fuse shapes (creates a single solid if possible)
    combined = shapes[0]
    for shape in shapes[1:]:
        try:
            combined = combined.fuse(shape)
        except Exception:
            # If fusion fails, create a compound instead
            combined = Part.makeCompound([combined, shape])
    
    return combined


def export_cad_file(shape, file_path):
    """
    Export a shape to a CAD file format.
    
    Args:
        shape: Part.Shape to export
        file_path: Output file path
    """
    ext = os.path.splitext(file_path)[1].lower()
    
    print(f"[FreeCAD] Exporting to {ext.upper()}...")
    
    if ext in (".step", ".stp"):
        # STEP export with options for quality
        Part.export([shape], file_path)
        
    elif ext in (".iges", ".igs"):
        # IGES export - use shape.exportIges() for proper geometry output
        # (Part.export produces empty 402 entities for some shape types)
        shape.exportIges(file_path)
        
    elif ext == ".dxf":
        # DXF export - need to use importDXF module
        # Create a temporary document with the shape
        doc = FreeCAD.ActiveDocument
        if doc is None:
            doc = FreeCAD.newDocument("Export")
        
        # Add shape as a Part Feature
        feature = doc.addObject("Part::Feature", "ExportShape")
        feature.Shape = shape
        
        # Export using importDXF
        importDXF.export([feature], file_path)
        
    elif ext == ".brep":
        # BREP export (native OpenCASCADE format)
        shape.exportBrep(file_path)
        
    else:
        raise ValueError(f"Unsupported output format: {ext}")


def main():
    input_path = os.environ.get("INPUT_FILE_PATH")
    output_path = os.environ.get("OUTPUT_FILE_PATH")
    
    if not input_path or not output_path:
        print("[FreeCAD] ERROR: INPUT_FILE_PATH and OUTPUT_FILE_PATH required")
        sys.exit(1)
    
    input_ext = os.path.splitext(input_path)[1].lower()
    output_ext = os.path.splitext(output_path)[1].lower()
    
    print(f"[FreeCAD] ════════════════════════════════════════════════════════")
    print(f"[FreeCAD] CAD-to-CAD Conversion")
    print(f"[FreeCAD] ════════════════════════════════════════════════════════")
    print(f"[FreeCAD] Input:  {input_path} ({input_ext.upper()})")
    print(f"[FreeCAD] Output: {output_path} ({output_ext.upper()})")
    print(f"[FreeCAD] ════════════════════════════════════════════════════════")
    
    # Create new document
    doc = FreeCAD.newDocument("CADConversion")
    
    try:
        # 1. Load input file
        shapes, doc = load_cad_file(input_path, doc)
        
        # 2. Combine shapes if multiple
        combined_shape = combine_shapes(shapes)
        
        # Log shape info
        print(f"[FreeCAD] Shape type: {combined_shape.ShapeType}")
        print(f"[FreeCAD] Solids: {len(combined_shape.Solids)}")
        print(f"[FreeCAD] Shells: {len(combined_shape.Shells)}")
        print(f"[FreeCAD] Faces:  {len(combined_shape.Faces)}")
        print(f"[FreeCAD] Edges:  {len(combined_shape.Edges)}")
        
        # 3. Export to output format
        export_cad_file(combined_shape, output_path)
        
        # 4. Verify output
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            output_size = os.path.getsize(output_path)
            print(f"[FreeCAD] ════════════════════════════════════════════════════════")
            print(f"[FreeCAD] SUCCESS")
            print(f"[FreeCAD] Output: {output_path}")
            print(f"[FreeCAD] Size:   {output_size} bytes ({output_size / 1024:.1f} KB)")
            print(f"[FreeCAD] ════════════════════════════════════════════════════════")
        else:
            print("[FreeCAD] ERROR: Output file not created or empty")
            sys.exit(1)
            
    except Exception as e:
        print(f"[FreeCAD] ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
        
    finally:
        # Clean up
        try:
            FreeCAD.closeDocument(doc.Name)
        except Exception:
            pass


if __name__ == "__main__":
    main()
