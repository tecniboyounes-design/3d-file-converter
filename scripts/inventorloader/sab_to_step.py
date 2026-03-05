#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sab_to_step.py - Extract ACIS 3DSOLID from DXF and convert to STEP via InventorLoader

Pipeline:
  1. ezdxf reads DXF file, extracts SAB (binary ACIS) data from 3DSOLID entities
  2. InventorLoader's Acis.py parses the SAB binary
  3. Acis2Step.py exports parsed ACIS bodies to STEP format

Usage: python3 sab_to_step.py <input.dxf> <output.step>

Must be run with FreeCAD Python environment (e.g., via freecad-convert wrapper
or with /usr/lib/freecad/lib on sys.path).
"""

import sys
import os
import io
import shutil
import tempfile

# Add InventorLoader directory to path
script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

# Add FreeCAD lib path if not already present
freecad_lib = '/usr/lib/freecad/lib'
if os.path.isdir(freecad_lib) and freecad_lib not in sys.path:
    sys.path.insert(0, freecad_lib)

# CRITICAL: Import FreeCAD and Part BEFORE ezdxf to avoid segfault
# caused by shared library conflicts between OpenCASCADE and numpy
import FreeCAD  # noqa: E402
import Part     # noqa: E402

def main():
    if len(sys.argv) != 3:
        print("Usage: sab_to_step.py <input.dxf> <output.step>", file=sys.stderr)
        sys.exit(1)

    input_dxf = sys.argv[1]
    output_step = sys.argv[2]

    if not os.path.isfile(input_dxf):
        print(f"Error: Input file not found: {input_dxf}", file=sys.stderr)
        sys.exit(1)

    print(f"[sab_to_step] Input DXF: {input_dxf}")
    print(f"[sab_to_step] Output STEP: {output_step}")

    # Step 1: Extract SAB data from DXF using ezdxf
    import ezdxf

    print("[sab_to_step] Reading DXF file...")
    doc = ezdxf.readfile(input_dxf)
    msp = doc.modelspace()

    solids = list(msp.query("3DSOLID"))
    if not solids:
        print("[sab_to_step] Error: No 3DSOLID entities found in DXF", file=sys.stderr)
        sys.exit(2)

    print(f"[sab_to_step] Found {len(solids)} 3DSOLID entities")

    # Step 2: Parse and convert each solid with InventorLoader
    import Acis
    import importerSAT
    import Acis2Step
    from Acis import setReader
    from importerUtils import setDumpFolder, getDumpFolder

    # setDumpFolder expects a file path - it creates {basename}_{ext}/ directory
    # We pass a fake file path so it creates a temp directory
    dump_base = tempfile.mkdtemp(prefix='inventorloader_')
    fake_file = os.path.join(dump_base, 'output.tmp')
    with open(fake_file, 'w') as f:
        f.write('')
    setDumpFolder(fake_file)
    dump_dir = getDumpFolder()
    print(f"[sab_to_step] Dump directory: {dump_dir}")

    all_step_files = []

    for i, solid in enumerate(solids):
        entity_name = f"solid_{i}"
        print(f"[sab_to_step] Processing 3DSOLID {i+1}/{len(solids)}...")

        # Get SAB binary data
        sab_data = solid.sab
        if not sab_data:
            # Try SAT text format
            sat_data = solid.sat
            if sat_data:
                print(f"[sab_to_step]   Using SAT text format")
                stream = io.StringIO('\n'.join(sat_data))
                reader = Acis.AcisReader(stream)
                reader.name = entity_name
                reader.readText()
            else:
                print(f"[sab_to_step]   No ACIS data found, skipping")
                continue
        else:
            print(f"[sab_to_step]   SAB data: {len(sab_data)} bytes")
            stream = io.BytesIO(sab_data)
            reader = Acis.AcisReader(stream)
            reader.name = entity_name
            reader.readBinary()

        # Resolve ACIS topology
        setReader(reader)
        bodies = importerSAT.resolveNodes(reader)
        print(f"[sab_to_step]   Resolved {len(bodies)} bodies")

        if bodies:
            # Export to STEP
            stepfile = Acis2Step.export(entity_name, reader.header, bodies)
            expected_step = os.path.join(dump_dir, f"{entity_name}.step")
            if os.path.isfile(expected_step) and os.path.getsize(expected_step) > 100:
                all_step_files.append(expected_step)
                print(f"[sab_to_step]   STEP exported: {os.path.getsize(expected_step)} bytes")
            else:
                print(f"[sab_to_step]   Warning: STEP file not generated or too small")

    if not all_step_files:
        print("[sab_to_step] Error: No STEP files were generated", file=sys.stderr)
        shutil.rmtree(dump_dir, ignore_errors=True)
        sys.exit(3)

    # Step 3: If multiple solids, merge STEP files; otherwise just copy
    if len(all_step_files) == 1:
        shutil.copy2(all_step_files[0], output_step)
    else:
        # Merge multiple STEP files into one
        print(f"[sab_to_step] Merging {len(all_step_files)} STEP files...")
        _merge_step_files(all_step_files, output_step)

    # Step 4: Clean up invalid STEP entities from InventorLoader output
    # InventorLoader sometimes writes decomposed complex entity subtypes as
    # separate standalone entities (e.g., BOUNDED_CURVE(), CURVE()), which are
    # invalid in STEP and cause viewers/parsers to reject the file.
    removed = _clean_step_file(output_step)
    if removed > 0:
        print(f"[sab_to_step] Cleaned {removed} invalid duplicate entities from STEP")

    # Cleanup temp dirs
    shutil.rmtree(dump_dir, ignore_errors=True)
    shutil.rmtree(dump_base, ignore_errors=True)

    if os.path.isfile(output_step) and os.path.getsize(output_step) > 0:
        print(f"[sab_to_step] Success! Output: {output_step} ({os.path.getsize(output_step)} bytes)")
        sys.exit(0)
    else:
        print("[sab_to_step] Error: Output STEP file is empty or missing", file=sys.stderr)
        sys.exit(4)


def _clean_step_file(step_path):
    """Remove invalid decomposed complex entities from InventorLoader STEP output.

    InventorLoader's Acis2Step.py sometimes writes complex entity subtypes as
    separate standalone entities in addition to the correct complex entity
    instances (parenthesized form). The standalone abstract supertypes like
    BOUNDED_CURVE(), CURVE(), GEOMETRIC_REPRESENTATION_ITEM() are invalid in
    ISO 10303-21 and cause STEP viewers/parsers to reject the file.

    Strategy:
    1. Find entity IDs that are part of complex entity definitions
    2. Collect entity IDs of standalone abstract supertypes (always invalid)
    3. Find unreferenced decomposed siblings adjacent to those invalid entities
    4. Remove all identified invalid/unreferenced entities
    """
    import re

    with open(step_path, 'r') as f:
        content = f.read()
        lines = content.splitlines(True)

    entity_pattern = re.compile(r'^#(\d+)\s*=\s*')

    # Patterns that are ALWAYS invalid as standalone STEP entities
    invalid_patterns = [
        re.compile(r'^#\d+\s*=\s*BOUNDED_CURVE\(\);'),
        re.compile(r'^#\d+\s*=\s*CURVE\(\);'),
        re.compile(r'^#\d+\s*=\s*GEOMETRIC_REPRESENTATION_ITEM\(\);'),
        re.compile(r'^#\d+\s*=\s*REPRESENTATION_ITEM\('),
    ]

    # First pass: collect IDs of invalid standalone entities
    invalid_ids = set()
    for line in lines:
        for pat in invalid_patterns:
            if pat.match(line):
                m = entity_pattern.match(line)
                if m:
                    invalid_ids.add(int(m.group(1)))
                break

    if not invalid_ids:
        return 0

    # Second pass: find unreferenced decomposed siblings
    # These are B_SPLINE_CURVE, B_SPLINE_CURVE_WITH_KNOTS, RATIONAL_B_SPLINE_CURVE
    # entities adjacent to the invalid ones (IDs within range of each invalid group)
    decomposed_patterns = [
        re.compile(r'^#\d+\s*=\s*B_SPLINE_CURVE\('),
        re.compile(r'^#\d+\s*=\s*B_SPLINE_CURVE_WITH_KNOTS\('),
        re.compile(r'^#\d+\s*=\s*RATIONAL_B_SPLINE_CURVE\('),
    ]

    # Build set of all entity IDs referenced in the file (excluding definitions)
    ref_pattern = re.compile(r'#(\d+)')
    all_references = set()
    for line in lines:
        m = entity_pattern.match(line)
        if m:
            # Skip the defining ID, collect only references in the value part
            eq_pos = line.index('=')
            refs = ref_pattern.findall(line[eq_pos+1:])
            all_references.update(int(r) for r in refs)

    # Find decomposed siblings: entities near invalid IDs that are unreferenced
    candidate_siblings = set()
    for line in lines:
        for pat in decomposed_patterns:
            if pat.match(line):
                m = entity_pattern.match(line)
                if m:
                    eid = int(m.group(1))
                    # Check if this entity is near an invalid one (within ±10 IDs)
                    for inv_id in invalid_ids:
                        if abs(eid - inv_id) <= 10:
                            candidate_siblings.add(eid)
                            break
                break

    # Only remove siblings that are truly unreferenced
    siblings_to_remove = candidate_siblings - all_references
    remove_ids = invalid_ids | siblings_to_remove

    # Third pass: remove all identified entities
    clean_lines = []
    removed = 0
    for line in lines:
        m = entity_pattern.match(line)
        if m and int(m.group(1)) in remove_ids:
            removed += 1
            continue
        clean_lines.append(line)

    if removed > 0:
        with open(step_path, 'w') as f:
            f.writelines(clean_lines)

    return removed


def _merge_step_files(step_files, output_path):
    """Merge multiple STEP files by combining their data sections."""
    # Simple approach: use FreeCAD to import all and re-export
    try:
        import FreeCAD
        import Part
        import Import

        doc = FreeCAD.newDocument("Merged")
        for sf in step_files:
            Part.insert(sf, doc.Name)

        shapes = []
        for obj in doc.Objects:
            if hasattr(obj, 'Shape') and obj.Shape and not obj.Shape.isNull():
                shapes.append(obj.Shape)

        if shapes:
            if len(shapes) == 1:
                compound = shapes[0]
            else:
                compound = Part.makeCompound(shapes)
            compound.exportStep(output_path)
        FreeCAD.closeDocument(doc.Name)
    except Exception as e:
        print(f"[sab_to_step] FreeCAD merge failed ({e}), using first file")
        shutil.copy2(step_files[0], output_path)


if __name__ == '__main__':
    main()
