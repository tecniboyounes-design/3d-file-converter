#!/usr/bin/env python3
"""
Mesh to IFC Converter

Converts OBJ files to IFC format (IFC4 schema).
Each OBJ group/object becomes a separate IfcBuildingElementProxy.

Features:
- Multi-object preservation: Each OBJ group → IfcBuildingElementProxy
- Hierarchy support: Reads colon notation (Obj.195:1) for parent-child relationships
- Optional JSON hierarchy file for custom parent-child mapping

Usage:
    python3 mesh_to_ifc.py input.obj output.ifc [hierarchy.json]
"""

import sys
import json
import os
import time
import uuid
from collections import defaultdict

try:
    import ifcopenshell
    import ifcopenshell.guid
    import ifcopenshell.api
except ImportError:
    print("ERROR: ifcopenshell not installed. Run: pip install ifcopenshell", file=sys.stderr)
    sys.exit(1)


def create_guid():
    """Create a unique GlobalId for IFC elements."""
    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def parse_obj_file(obj_path):
    """
    Parse OBJ file and extract groups with their geometry.
    
    Returns:
        dict: {group_name: {'vertices': [...], 'faces': [...]}}
    """
    groups = {}
    current_group = 'default'
    all_vertices = []  # Global vertex list (1-indexed in OBJ)
    group_faces = defaultdict(list)
    
    print(f"Parsing OBJ file: {obj_path}")
    
    with open(obj_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            
            parts = line.split()
            cmd = parts[0].lower()
            
            if cmd == 'v':
                # Vertex: v x y z
                x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
                all_vertices.append((x, y, z))
            
            elif cmd == 'g' or cmd == 'o':
                # Group or object: g name / o name
                if len(parts) > 1:
                    current_group = ' '.join(parts[1:])
                else:
                    current_group = 'default'
            
            elif cmd == 'f':
                # Face: f v1 v2 v3 ... (may include texture/normal indices)
                face_indices = []
                for p in parts[1:]:
                    # Handle v/vt/vn format - we only need vertex index
                    idx = p.split('/')[0]
                    face_indices.append(int(idx))
                group_faces[current_group].append(face_indices)
    
    # Build per-group geometry with local vertex indices
    for group_name, faces in group_faces.items():
        # Find all vertices used by this group
        used_indices = set()
        for face in faces:
            used_indices.update(face)
        
        # Create local vertex list and index mapping
        sorted_indices = sorted(used_indices)
        global_to_local = {g: l for l, g in enumerate(sorted_indices)}
        
        local_vertices = [all_vertices[i - 1] for i in sorted_indices]  # OBJ is 1-indexed
        local_faces = []
        for face in faces:
            local_face = [global_to_local[i] for i in face]
            local_faces.append(local_face)
        
        groups[group_name] = {
            'vertices': local_vertices,
            'faces': local_faces
        }
    
    print(f"Found {len(groups)} groups, {len(all_vertices)} total vertices")
    return groups


def parse_hierarchy_from_names(groups):
    """
    Parse parent-child relationships from colon notation in group names.
    
    Examples:
        - "Obj.195" is a parent
        - "Obj.195:1" is child of "Obj.195"
        - "Obj.195:1:1" is child of "Obj.195:1"
    
    Returns:
        dict: {child_name: parent_name}
    """
    hierarchy = {}
    group_names = set(groups.keys())
    
    for name in group_names:
        if ':' in name:
            # Find parent by removing last colon segment
            parts = name.rsplit(':', 1)
            parent_name = parts[0]
            
            # Only create relationship if parent exists
            if parent_name in group_names:
                hierarchy[name] = parent_name
    
    parent_count = len(set(hierarchy.values()))
    child_count = len(hierarchy)
    print(f"Hierarchy from names: {parent_count} parents, {child_count} children")
    
    return hierarchy


def load_hierarchy_json(json_path):
    """
    Load hierarchy from JSON file.
    
    Expected format:
        {"parent_name": ["child1", "child2"], ...}
    
    Returns:
        dict: {child_name: parent_name}
    """
    with open(json_path, 'r') as f:
        data = json.load(f)
    
    hierarchy = {}
    for parent, children in data.items():
        for child in children:
            hierarchy[child] = parent
    
    print(f"Loaded hierarchy from JSON: {len(hierarchy)} relationships")
    return hierarchy


def create_ifc_file(groups, hierarchy, output_path):
    """
    Create IFC file with all groups as IfcBuildingElementProxy elements.
    
    Each group becomes a separate element that can be selected in BIM viewers.
    Hierarchy is preserved via IfcRelAggregates.
    """
    print("Creating IFC4 file...")
    
    # Create new IFC file with IFC4 schema
    ifc = ifcopenshell.file(schema='IFC4')
    
    # Use ifcopenshell.api for proper element creation
    project = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcProject", name="Converted Model")
    
    # Set units (meters)
    ifcopenshell.api.run("unit.assign_unit", ifc, length={"is_metric": True, "raw": "METERS"})
    
    # Create site
    site = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcSite", name="Site")
    ifcopenshell.api.run("aggregate.assign_object", ifc, relating_object=project, products=[site])
    
    # Create building
    building = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcBuilding", name="Building")
    ifcopenshell.api.run("aggregate.assign_object", ifc, relating_object=site, products=[building])
    
    # Create building storey
    storey = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcBuildingStorey", name="Ground Floor")
    ifcopenshell.api.run("aggregate.assign_object", ifc, relating_object=building, products=[storey])
    
    # Create geometry context
    context = ifcopenshell.api.run("context.add_context", ifc, context_type="Model")
    body_context = ifcopenshell.api.run("context.add_context", ifc, 
        context_type="Model", 
        context_identifier="Body", 
        target_view="MODEL_VIEW", 
        parent=context
    )
    
    # Track created elements for hierarchy
    elements = {}
    root_elements = []  # Elements without parents
    
    print(f"Creating {len(groups)} IfcBuildingElementProxy elements...")
    
    # Create an element for each group
    for group_name, geom in groups.items():
        vertices = geom['vertices']
        faces = geom['faces']
        
        if not vertices or not faces:
            print(f"  Skipping empty group: {group_name}")
            continue
        
        # Create IfcBuildingElementProxy
        element = ifcopenshell.api.run("root.create_entity", ifc, 
            ifc_class="IfcBuildingElementProxy",
            name=group_name,
            predefined_type="ELEMENT"
        )
        
        # Create triangulated face set for geometry
        try:
            # Flatten vertices for IFC
            coords_list = [coord for v in vertices for coord in v]
            
            # Triangulate faces (IFC needs triangles)
            triangles = []
            for face in faces:
                if len(face) >= 3:
                    # Fan triangulation for polygons
                    for i in range(1, len(face) - 1):
                        # IFC uses 1-based indexing
                        triangles.append((face[0] + 1, face[i] + 1, face[i + 1] + 1))
            
            if triangles:
                # Create coordinate list
                point_list = ifc.createIfcCartesianPointList3D(
                    [vertices[i] for i in range(len(vertices))]
                )
                
                # Create triangulated face set
                face_set = ifc.createIfcTriangulatedFaceSet(point_list, None, None, triangles, None)
                
                # Create shape representation
                representation = ifc.createIfcShapeRepresentation(
                    body_context,
                    "Body",
                    "Tessellation",
                    [face_set]
                )
                
                # Create product definition shape
                product_shape = ifc.createIfcProductDefinitionShape(None, None, [representation])
                element.Representation = product_shape
                
                # Create placement
                origin = ifc.createIfcCartesianPoint((0.0, 0.0, 0.0))
                placement_3d = ifc.createIfcAxis2Placement3D(origin, None, None)
                local_placement = ifc.createIfcLocalPlacement(None, placement_3d)
                element.ObjectPlacement = local_placement
        
        except Exception as e:
            print(f"  Warning: Could not create geometry for {group_name}: {e}")
        
        elements[group_name] = element
        
        # Track if this is a root element (no parent)
        if group_name not in hierarchy:
            root_elements.append(element)
    
    print(f"Created {len(elements)} elements")
    
    # Assign root elements to storey
    for element in root_elements:
        ifcopenshell.api.run("spatial.assign_container", ifc, 
            relating_structure=storey, 
            products=[element]
        )
    
    # Create hierarchy relationships
    print("Creating hierarchy relationships...")
    children_by_parent = defaultdict(list)
    for child_name, parent_name in hierarchy.items():
        if child_name in elements and parent_name in elements:
            children_by_parent[parent_name].append(child_name)
    
    for parent_name, child_names in children_by_parent.items():
        parent_element = elements[parent_name]
        for child_name in child_names:
            child_element = elements[child_name]
            try:
                ifcopenshell.api.run("aggregate.assign_object", ifc,
                    relating_object=parent_element,
                    products=[child_element]
                )
            except Exception as e:
                print(f"  Warning: Could not create hierarchy {parent_name} → {child_name}: {e}")
    
    print(f"Created {sum(len(v) for v in children_by_parent.values())} parent-child relationships")
    
    # Write file
    print(f"Writing IFC file: {output_path}")
    ifc.write(output_path)
    
    file_size = os.path.getsize(output_path)
    print(f"Success: {file_size:,} bytes written")
    
    return output_path


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 mesh_to_ifc.py input.obj output.ifc [hierarchy.json]")
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    hierarchy_path = sys.argv[3] if len(sys.argv) > 3 else None
    
    if not os.path.exists(input_path):
        print(f"ERROR: Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)
    
    start_time = time.time()
    
    # Parse OBJ file
    groups = parse_obj_file(input_path)
    
    if not groups:
        print("ERROR: No groups found in OBJ file", file=sys.stderr)
        sys.exit(1)
    
    # Get hierarchy
    if hierarchy_path and os.path.exists(hierarchy_path):
        hierarchy = load_hierarchy_json(hierarchy_path)
    else:
        hierarchy = parse_hierarchy_from_names(groups)
    
    # Create IFC file
    create_ifc_file(groups, hierarchy, output_path)
    
    elapsed = time.time() - start_time
    print(f"Conversion completed in {elapsed:.2f} seconds")


if __name__ == '__main__':
    main()
