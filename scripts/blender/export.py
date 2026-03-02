import bpy
import sys
import os
import json
import re

# read from environment variables
output_file_path = os.environ["OUTPUT_FILE_PATH"]
output_file_format = os.environ["OUTPUT_FILE_FORMAT"]
input_file_path = os.environ["INPUT_FILE_PATH"]
input_file_format = os.environ["INPUT_FILE_FORMAT"]
# Hierarchy JSON from APS object tree (optional, for OBJ→GLB with hierarchy)
obj_hierarchy_json = os.environ.get("OBJ_HIERARCHY_JSON", "")

#--------------------------------------------------------------------
# Reset to factory settings FIRST
#--------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

#--------------------------------------------------------------------
# Enable Plugins AFTER reset
#--------------------------------------------------------------------
from addon_utils import check, enable

# Enable required addons
addons_to_enable = ["io_scene_gltf2"]

# Add DXF exporter if DXF output is requested
if output_file_format == "dxf":
    addons_to_enable.append("io_export_dxf")

for addon in addons_to_enable:
    try:
        default, enabled = check(addon)
        if not enabled:
            enable(addon, default_set=True, persistent=True)
            print(f"[Blender] Enabled addon: {addon}")
    except Exception as e:
        print(f"[Blender] Warning: Could not enable addon {addon}: {e}")

#--------------------------------------------------------------------
# Sanity Checks
#--------------------------------------------------------------------

if input_file_format == output_file_format:
  print("[Blender] Warning: Same format input/output")

print(f"[Blender] Converting: {input_file_format} → {output_file_format}")
print(f"[Blender] Input: {input_file_path}")
print(f"[Blender] Output: {output_file_path}")

#--------------------------------------------------------------------
# Load 3D File from path
#--------------------------------------------------------------------

if input_file_format == "obj":
  # Import OBJ - missing MTL warnings are normal and don't prevent import
  # use_split_groups=True: Import each OBJ 'g' (group) as a separate Blender object
  # This is essential for preserving hierarchy from APS object tree
  bpy.ops.wm.obj_import(filepath=input_file_path, use_split_groups=True)
elif input_file_format == "stl":
  bpy.ops.wm.stl_import(filepath=input_file_path)
elif input_file_format == "ply":
  bpy.ops.wm.ply_import(filepath=input_file_path)
elif input_file_format == "fbx":
  bpy.ops.import_scene.fbx(filepath=input_file_path)
elif input_file_format in ("gltf", "glb"):
  bpy.ops.import_scene.gltf(filepath=input_file_path)
elif input_file_format == "dae":
  bpy.ops.wm.collada_import(filepath=input_file_path)
elif input_file_format == "3ds":
  bpy.ops.import_scene.autodesk_3ds(filepath=input_file_path)
elif input_file_format == "dxf":
  # Check if it's a binary DXF (not supported by Blender)
  with open(input_file_path, 'rb') as f:
    header = f.read(22)
    if b'AutoCAD Binary DXF' in header:
      print("[Blender] ERROR: Binary DXF format not supported. Convert to ASCII DXF first.")
      sys.exit(1)
  
  # Enable DXF importer
  enable("io_import_dxf", default_set=True, persistent=True)
  try:
    result = bpy.ops.import_scene.dxf(filepath=input_file_path)
    if result != {'FINISHED'}:
      print(f"[Blender] ERROR: DXF import returned {result}")
      sys.exit(1)
  except Exception as e:
    print(f"[Blender] ERROR: DXF import failed: {e}")
    sys.exit(1)
else:
  print(f"[Blender] ERROR: Unsupported input format: {input_file_format}")
  sys.exit(1)

# Verify objects were imported
if len(bpy.data.objects) == 0:
  print("[Blender] ERROR: No objects imported")
  sys.exit(1)

print(f"[Blender] Imported {len(bpy.data.objects)} objects")

#--------------------------------------------------------------------
# Build Hierarchy from Colon Notation (Obj.XXX:1 → child of Obj.XXX)
# This groups objects based on naming convention in the OBJ file
#--------------------------------------------------------------------

def apply_colon_hierarchy():
  """
  Create parent-child relationships based on colon notation in object names.
  Objects like "Obj.195:1", "Obj.195:2" become children of "Obj.195".
  This also handles rehydrated names like "ComponentName_195:1" → child of "ComponentName_195"
  """
  # Build a mapping of base names (without colon suffix) to their objects
  base_to_objects = {}  # base_name -> list of (suffix, object)
  parent_candidates = {}  # base_name -> parent object (without colon)
  
  for obj in list(bpy.data.objects):
    name = obj.name
    
    # Check for colon notation: Obj.195:1 or ComponentName_195:1
    colon_match = re.match(r'^(.+):(\d+)$', name)
    if colon_match:
      base_name = colon_match.group(1)
      suffix = int(colon_match.group(2))
      if base_name not in base_to_objects:
        base_to_objects[base_name] = []
      base_to_objects[base_name].append((suffix, obj))
    else:
      # This might be a parent object (no colon suffix)
      # Check if it matches Obj.XXX or ends with _XXX pattern
      if re.match(r'^Obj\.\d+$', name) or re.search(r'_\d+$', name):
        parent_candidates[name] = obj
  
  if not base_to_objects:
    print("[Blender] No colon-notation objects found for hierarchy grouping")
    return 0
  
  # Now create parent-child relationships
  parented_count = 0
  
  for base_name, children_list in base_to_objects.items():
    # Find or create the parent object
    parent_obj = parent_candidates.get(base_name)
    
    if parent_obj is None:
      # Parent doesn't exist as a geometry object, create an empty
      clean_name = base_name
      empty = bpy.data.objects.new(clean_name, None)
      empty.empty_display_type = 'PLAIN_AXES'
      empty.empty_display_size = 0.1
      bpy.context.scene.collection.objects.link(empty)
      parent_obj = empty
      print(f"[Blender] Created empty parent: {clean_name}")
    
    # Parent all children to this parent
    for suffix, child_obj in children_list:
      if child_obj.parent != parent_obj:
        # Store world matrix before parenting
        world_matrix = child_obj.matrix_world.copy()
        child_obj.parent = parent_obj
        # Restore world position (keep in place)
        child_obj.matrix_world = world_matrix
        parented_count += 1
  
  return parented_count

# Apply colon-based hierarchy for OBJ imports
if input_file_format == "obj":
  parented = apply_colon_hierarchy()
  if parented > 0:
    print(f"[Blender] Applied {parented} colon-notation parent-child relationships")

#--------------------------------------------------------------------
# Build Hierarchy from APS Object Tree (if available)
# This reconstructs parent-child relationships for GLB export
#--------------------------------------------------------------------

def extract_object_id_from_name(name):
  """
  Extract the APS object ID from Blender object name.
  Names are in format: "ComponentName_123" or "Obj.123" or "Obj.123:1"
  Returns the numeric ID or None if not found.
  """
  # Try pattern: name ending with _123 (rehydrated name)
  match = re.search(r'_(\d+)(?:_\d+)?$', name)
  if match:
    return int(match.group(1))
  
  # Try pattern: Obj.123 or Obj.123:1 (original APS name)
  match = re.search(r'Obj\.(\d+)', name)
  if match:
    return int(match.group(1))
  
  return None

def build_id_to_parent_map(objects_list, parent_id=None, result=None):
  """
  Recursively build a map from object ID to parent ID from the APS tree.
  """
  if result is None:
    result = {}
  
  for obj in objects_list:
    obj_id = obj.get('objectid')
    if obj_id is not None:
      result[obj_id] = parent_id
      # Recursively process children
      children = obj.get('objects', [])
      if children:
        build_id_to_parent_map(children, obj_id, result)
  
  return result

def apply_hierarchy_from_aps(hierarchy_data):
  """
  Apply parent-child relationships from APS object tree to Blender objects.
  Creates empty parent objects for hierarchy nodes that don't have geometry.
  """
  if not hierarchy_data or 'data' not in hierarchy_data:
    print("[Blender] No valid hierarchy data")
    return
  
  root_objects = hierarchy_data.get('data', {}).get('objects', [])
  if not root_objects:
    print("[Blender] No objects in hierarchy")
    return
  
  # Build mapping: objectid -> parent_objectid
  id_to_parent = build_id_to_parent_map(root_objects)
  print(f"[Blender] Built parent map with {len(id_to_parent)} entries")
  
  # Build mapping: objectid -> object info (for creating parent empties)
  id_to_info = {}
  def collect_info(objects_list):
    for obj in objects_list:
      obj_id = obj.get('objectid')
      if obj_id is not None:
        id_to_info[obj_id] = {
          'name': obj.get('name', f'Node_{obj_id}'),
          'has_children': len(obj.get('objects', [])) > 0
        }
        collect_info(obj.get('objects', []))
  collect_info(root_objects)
  
  # Build mapping: objectid -> Blender object
  id_to_blender_obj = {}
  for obj in bpy.data.objects:
    obj_id = extract_object_id_from_name(obj.name)
    if obj_id is not None:
      id_to_blender_obj[obj_id] = obj
  
  print(f"[Blender] Matched {len(id_to_blender_obj)} Blender objects to hierarchy IDs")
  
  # Create empty parent objects for hierarchy nodes that only have children (no geometry)
  created_empties = {}
  for obj_id, info in id_to_info.items():
    if info['has_children'] and obj_id not in id_to_blender_obj:
      # This is a hierarchy-only node, create an empty
      # Clean up name for Blender (remove special chars)
      clean_name = re.sub(r'[\[\]\(\)]', '', info['name']).replace(' ', '_')
      empty = bpy.data.objects.new(clean_name, None)
      empty.empty_display_type = 'PLAIN_AXES'
      empty.empty_display_size = 0.1
      bpy.context.scene.collection.objects.link(empty)
      id_to_blender_obj[obj_id] = empty
      created_empties[obj_id] = empty
  
  if created_empties:
    print(f"[Blender] Created {len(created_empties)} empty parent objects")
  
  # Apply parenting relationships
  parented_count = 0
  for obj_id, blender_obj in id_to_blender_obj.items():
    parent_id = id_to_parent.get(obj_id)
    if parent_id is not None and parent_id in id_to_blender_obj:
      parent_obj = id_to_blender_obj[parent_id]
      if blender_obj.parent != parent_obj:
        # Store world matrix before parenting
        world_matrix = blender_obj.matrix_world.copy()
        blender_obj.parent = parent_obj
        # Restore world position (keep in place)
        blender_obj.matrix_world = world_matrix
        parented_count += 1
  
  print(f"[Blender] Applied {parented_count} parent-child relationships")

# Apply hierarchy if we have APS object tree data
if obj_hierarchy_json and output_file_format in ('glb', 'gltf'):
  print("[Blender] Applying APS hierarchy to objects...")
  try:
    hierarchy_data = json.loads(obj_hierarchy_json)
    apply_hierarchy_from_aps(hierarchy_data)
    print("[Blender] Hierarchy applied successfully!")
  except json.JSONDecodeError as e:
    print(f"[Blender] Warning: Failed to parse hierarchy JSON: {e}")
  except Exception as e:
    print(f"[Blender] Warning: Failed to apply hierarchy: {e}")

#--------------------------------------------------------------------
# Optional Mesh Decimation (for STEP pipeline - reduces FreeCAD memory)
#--------------------------------------------------------------------
decimate_target = os.environ.get("DECIMATE_TARGET_FACES", "")
if decimate_target:
  target = int(decimate_target)
  total_faces = sum(len(obj.data.polygons) for obj in bpy.data.objects if obj.type == 'MESH')
  if total_faces > target:
    ratio = target / total_faces
    print(f"[Blender] Decimating: {total_faces} → ~{target} faces (ratio={ratio:.3f})")
    for obj in bpy.data.objects:
      if obj.type == 'MESH' and len(obj.data.polygons) > 0:
        mod = obj.modifiers.new("Decimate", 'DECIMATE')
        mod.ratio = ratio
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier="Decimate")
    new_total = sum(len(obj.data.polygons) for obj in bpy.data.objects if obj.type == 'MESH')
    print(f"[Blender] After decimation: {new_total} faces")
  else:
    print(f"[Blender] Mesh is small enough ({total_faces} faces), skipping decimation")

#--------------------------------------------------------------------
# Export 3D File
#--------------------------------------------------------------------

print(f"[Blender] Exporting to {output_file_format}...")

if output_file_format == "fbx":
  bpy.ops.export_scene.fbx(filepath=output_file_path, axis_forward="-Z", axis_up="Y")
elif output_file_format == "obj":
  # Blender 4.0 uses wm.obj_export instead of export_scene.obj
  bpy.ops.wm.obj_export(filepath=output_file_path)
elif output_file_format == "stl":
  # Blender 4.0 uses export_mesh.stl (not wm.stl_export)
  bpy.ops.export_mesh.stl(filepath=output_file_path, use_selection=False, ascii=False)
elif output_file_format == "ply":
  bpy.ops.wm.ply_export(filepath=output_file_path)
elif output_file_format == "glb":
  bpy.ops.export_scene.gltf(filepath=output_file_path, export_format="GLB")
elif output_file_format == "gltf":
  bpy.ops.export_scene.gltf(filepath=output_file_path, export_format="GLTF_EMBEDDED")
elif output_file_format == "dae":
  bpy.ops.wm.collada_export(filepath=output_file_path)
elif output_file_format == "3ds":
  bpy.ops.export_scene.autodesk_3ds(filepath=output_file_path)
elif output_file_format == "dxf":
  bpy.ops.export.dxf(
    filepath=output_file_path,
    projectionThrough="NO",
    onlySelected=False,
    apply_modifiers=True,
    mesh_as="3DFACEs",
    entitylayer_from="obj.data.name",
    entitycolor_from="default_COLOR",
    entityltype_from="CONTINUOUS",
    layerName_from="LAYERNAME_DEF",
    verbose=True
  )
else:
  print(f"[Blender] ERROR: Unsupported output format: {output_file_format}")
  sys.exit(1)

# Verify output file was created
if os.path.exists(output_file_path):
  file_size = os.path.getsize(output_file_path)
  print(f"[Blender] Export complete: {output_file_path} ({file_size} bytes)")
else:
  print(f"[Blender] ERROR: Output file was not created: {output_file_path}")
  sys.exit(1)