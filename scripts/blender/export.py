import bpy
import sys
import os
import re

# read from environment variables
output_file_path = os.environ["OUTPUT_FILE_PATH"]
output_file_format = os.environ["OUTPUT_FILE_FORMAT"]
input_file_path = os.environ["INPUT_FILE_PATH"]
input_file_format = os.environ["INPUT_FILE_FORMAT"]

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
# Optional Mesh Decimation (for STEP pipeline - reduces FreeCAD memory)
#--------------------------------------------------------------------
decimate_target = os.environ.get("DECIMATE_TARGET_FACES", "")
if decimate_target:
  target = int(decimate_target)
  mesh_objects = [obj for obj in bpy.data.objects if obj.type == 'MESH' and len(obj.data.polygons) > 0]
  total_faces = sum(len(obj.data.polygons) for obj in mesh_objects)
  if total_faces > target:
    print(f"[Blender] Decimating: {total_faces} → ~{target} faces across {len(mesh_objects)} objects")
    
    # Join all meshes into one object first for uniform decimation
    # This avoids crashing on small objects with aggressive ratios
    bpy.ops.object.select_all(action='DESELECT')
    for obj in mesh_objects:
      obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]
    
    if len(mesh_objects) > 1:
      bpy.ops.object.join()
      print(f"[Blender] Joined {len(mesh_objects)} objects into one mesh")
    
    combined = bpy.context.view_layer.objects.active
    combined_faces = len(combined.data.polygons)
    ratio = max(target / combined_faces, 0.01)
    print(f"[Blender] Combined mesh: {combined_faces} faces, applying ratio={ratio:.4f}")
    
    mod = combined.modifiers.new("Decimate", 'DECIMATE')
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier="Decimate")
    
    new_total = len(combined.data.polygons)
    print(f"[Blender] After decimation: {new_total} faces")
  else:
    print(f"[Blender] Mesh is small enough ({total_faces} faces), skipping decimation")

#--------------------------------------------------------------------
# Export 3D File
#--------------------------------------------------------------------

print(f"[Blender] Exporting to {output_file_format}...")

if output_file_format == "fbx":
  bpy.ops.export_scene.fbx(
    filepath=output_file_path,
    axis_forward="-Z",
    axis_up="Y",
    object_types={'MESH', 'EMPTY'},
    add_leaf_bones=False,
    bake_anim=False,
  )
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
  # Blender 4.0 removed GLTF_EMBEDDED; use GLTF_SEPARATE then embed .bin as base64 data URI
  gltf_base = os.path.splitext(output_file_path)[0]
  bpy.ops.export_scene.gltf(filepath=output_file_path, export_format="GLTF_SEPARATE")
  bin_path = gltf_base + ".bin"
  if os.path.exists(bin_path) and os.path.exists(output_file_path):
    import json, base64
    with open(bin_path, "rb") as bf:
      bin_data = bf.read()
    with open(output_file_path, "r") as gf:
      gltf_json = json.load(gf)
    # Replace external buffer URI with embedded base64 data URI
    if "buffers" in gltf_json:
      for buf in gltf_json["buffers"]:
        if "uri" in buf:
          buf["uri"] = "data:application/octet-stream;base64," + base64.b64encode(bin_data).decode("ascii")
    with open(output_file_path, "w") as gf:
      json.dump(gltf_json, gf)
    os.remove(bin_path)
    print(f"[Blender] Embedded .bin into .gltf as base64 data URI")
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