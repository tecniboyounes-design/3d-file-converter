import bpy
import sys
import os

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
  bpy.ops.wm.obj_import(filepath=input_file_path)
elif input_file_format == "fbx":
  bpy.ops.import_scene.fbx(filepath=input_file_path)
elif input_file_format in ("gltf", "glb"):
  bpy.ops.import_scene.gltf(filepath=input_file_path)
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
# Export 3D File
#--------------------------------------------------------------------

print(f"[Blender] Exporting to {output_file_format}...")

if output_file_format == "fbx":
  bpy.ops.export_scene.fbx(filepath=output_file_path, axis_forward="-Z", axis_up="Y")
elif output_file_format == "obj":
  # Blender 4.0 uses wm.obj_export instead of export_scene.obj
  bpy.ops.wm.obj_export(filepath=output_file_path)
elif output_file_format == "glb":
  bpy.ops.export_scene.gltf(filepath=output_file_path, export_format="GLB")
elif output_file_format == "gltf":
  bpy.ops.export_scene.gltf(filepath=output_file_path, export_format="GLTF_EMBEDDED")
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