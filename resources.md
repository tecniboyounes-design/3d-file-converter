https://github.com/orbingol/cmake-modules

```CMake Find Modules for Solid Modeling Kernels
This repository contains the following CMake find modules:

findACIS.cmake: Finds libraries and headers of Spatial Corporation's 3D ACIS Modeler.
Usage Examples
findACIS.cmake:
Create directory <project_root>/cmake-modules and findACIS.cmake in this directory
Alternatively, you can clone this repository directly in your <project_root>
Use the following (or modify it for your needs) in your CMakeLists.txt file
cmake_minimum_required ( VERSION 2.8.11 )
project ( MyACISApp )

# Extend CMake module path for loading custom modules
set ( CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CMAKE_CURRENT_LIST_DIR}/cmake-modules" )

# findACIS module accepts a parameter for processing additional search paths
set ( ACIS_ROOT "/opt" CACHE PATH "3D ACIS Modeler custom install path." )

# Find 3D ACIS Modeler headers and libraries
find_package ( ACIS REQUIRED )

# Check if CMake has found libraries and headers for 3D ACIS Modeler
if ( ACIS_FOUND )
  include_directories ( ${ACIS_INCLUDE_DIRS} )
  # Unset ACIS_ROOT
  unset ( ACIS_ROOT )
  unset ( ACIS_ROOT CACHE )
else ()
  message(FATAL_ERROR "ACIS not found")
endif ()
3D ACIS Modeler requires Threads library. To link ACIS and Threads library (and the other required components):

target_link_libraries ( MyACISApp ${ACIS_LINK_LIBRARIES} )
It is also possible to generate INSTALL rules as descibed below:

# Install ACIS Release .DLL/.SO to the application install directory
install (
  FILES ${ACIS_REDIST_RELEASE}
  DESTINATION ${APP_INSTALL_DIR}
  CONFIGURATIONS Release RelWithDebInfo MinSizeRel
)

# Install ACIS Debug .DLL/.SO to to the application install directory
install (
  FILES ${ACIS_REDIST_DEBUG}
  DESTINATION ${APP_INSTALL_DIR}
  CONFIGURATIONS Debug
)
findACIS.cmake Components:
It is also possible to find 3D ACIS-HOOPS Bridge by adding a COMPONENTS argument to find_package. It will be automatically added to ACIS_LINK_LIBRARIES variable:

find_package ( ACIS COMPONENTS HBRIDGE REQUIRED )
The other components that can be discovered by this CMake find module are

Precise Hidden Line Removal V5 - PHLV5
Defeaturing - DEFEATURE
Advanced Deformable Modeling - ADMHUSK
Author
Onur Rauf Bingol (contact@onurbingol.net)
License
CMake find modules are released under The Unlicense. ACIS and SAT are registered trademarks of Spatial Corporation, a subsidiary of Dassault Systemes.
```

https://github.com/orbingol/ACIS-Python3
```
Python 3 wrapper module for 3D ACIS Modeler
DOI

ACIS-Python3 is a Python 3 module which provides a direct interface to Spatial Corporation's 3D ACIS Modeler solid modeling kernel.

For Researchers
I would be glad if you cite this repository using the DOI provided as a badge at the top.

Introduction
This package wraps Spatial Corporation's 3D ACIS Modeler into a Python (v3.5.x and v3.6.x) module with minor changes due to how Python's C interface works. 3D ACIS Modeler or ACIS, in short, is a solid and geometric modeling kernel. Solid modeling kernels are sometimes called as "CAD Engines" too. These systems work behind the scenes and responsible for generation of solid models or surfaces, evaluation of geometric operations on solid models or surfaces, and so.

3D ACIS Modeler provides a C++ API and its Scheme extension with variety of additional features. Even though it is used in a variety of commercial and research applications, it doesn't provide a Python interface which would be very useful for integration purposes. This module tries to fulfill the gap up to some point.

If you are

not aware of what solid modeling or a CAD kernel is
looking for the source code of a proprietary software
seeking for help on CAD programming
you might be checking the wrong place. This repository only contains the source code for the 3D ACIS Modeler Python wrapper.

Getting Started
This package depends on 3D ACIS Modeler headers and libraries. In order to obtain these, you might need to contact Spatial Corporation for developer or university licenses.

After obtaining 3D ACIS Modeler, please follow the steps below:

Clone the repository: git clone https://github.com/orbingol/ACIS-Python3.git
Update the submodules: git submodule update --init --recursive
Install Python 3 and its development package, if necessary
Install CMake
Using CMake GUI, choose the root of your cloned repository as the source directory
Choose a build directory, preferable different from the source directory. You can use <project_root>/build for this purpose.
Press configure button and choose your builder type, e.g. Visual Studio 2015 or Unix Makefiles.
Set ACIS_ROOT to your ACIS installation directory; e.g. C:\Program Files\Spatial\acisR26. CMake will automatically find and fill the necessary variables.
Don't forget to set Python library paths in CMake GUI.
Use APP_INSTALL_DIR to set the install path for the module
At the final step, press generate button and you are all set!
If you prefer, you can use CMake's command line tool to set up variables and generate build files.

Compiling and Installing the Module
Most of the time a simple make install will take care of all necessary operations. Please note that, you have to run it in your build directory, not in your source directory.

The following CMake targets are also provided for convenience:

make uninstall: Deletes installed files
make install_module: Generates a .pth file inside the site-packages directory. May require root/admin priviliges.
make uninstall_module: Deletes the .pth file inside the site-packages directory. May require root/admin privileges.
Please try using make uninstall and make clean, if you encounter any problems during compile or running stages.

By default, the module name is set to ACIS. The CMake variable APP_MODULE_NAME allows users to change the module name. Please don't forget to modify the import line in your Python code after changing the module name via CMake.

For Visual Studio 2015 users, you will see a lot of projects in your solution. If you only want to compile and run the package, right click on INSTALL and choose Rebuild.

Using the Module
Please check examples/ directory for example scripts and the instructions on how to use these scripts.

Function Reference
Please see the Function Reference to check which functions were implemented in this module.

Implementation Details
Please see IMPLEMENTATION for a discussion on the implementation details and assumptions.

Author (Python module)
Onur Rauf Bingol (contact@onurbingol.net)
Licensing
The Python module is released under MIT License. ACIS and SAT are registered trademarks of Spatial Corporation, a subsidiary of Dassault Systemes.
```


```
Exported solids using EZDXF are not behaving as expected in AutoCAD using Dynamo for intersection of solids
#1295
@kvermeulen26
kvermeulen26
on May 13, 2025 · 1 comment
 Answered by mozman Return to top

kvermeulen26
on May 13, 2025
I am working on a project where we generate 3D solids based on polygons with a height and material, export these to DXF so a CAD modeller can make extrusions with Dynamo and calculate volumes using these intersected solids.
While the export in solids seems to be working (massprop command in AutoCAD works on exported solids), the intersection script in Dynamo does not work properly on the exported solids, while it works properly on solids created within AutoCAD itself.
This suggests the solids created using ezdxf are missing some metadata or the data structure is somehow different. I ran the info and audit commands on the DXF export:

Filename: Path/ DXF_export_model.dxf"
Format: ASCII
Release: R2018
DXF Version: AC1032
Codepage: ANSI_1252
Encoding: utf-8
Layouts:
'Model'
'Layout1'
Created by ezdxf: 1.4.0 @ 2025-03-24T13:53:49.162567+00:00
auditing file: path\DXF_export_model.dxf
No errors found.
This is my code creating the 3D solids using ezdxf. I do not have much experience with ezdxf so I hope somebody can perhaps point out some possible errors in how these solids are created:
def save_to_dxf_3dsolid(polygon, base_height, top_height, msp, material, surface, color):
if round(base_height, 2) == round(top_height, 2):
return 0

try:
    # Create a mesh that represents the extruded polygon
    mesh = ezdxf.render.MeshBuilder()

    # Get the polygon points
    points = list(polygon.exterior.coords)
    if points[0] == points[-1]:  # Remove duplicate last point if it exists
        points = points[:-1]

    # Create bottom face
    bottom_points = [(x, y, base_height) for x, y in points]

    # Create top face
    if surface is not False:
        top_points = [(x, y, nearest_points(surface, Point(x, y))[0].z) for x, y in points]
    else:
        top_points = [(x, y, top_height) for x, y in points]

    # Add bottom face to mesh (reversed for correct normal direction)
    mesh.add_face(list(reversed(bottom_points)))

    # Add top face to mesh
    mesh.add_face(top_points)

    # Add side faces
    for i in range(len(points)):
        next_i = (i + 1) % len(points)

        # Define the four corner points of this side face
        quad = [
            bottom_points[i],
            bottom_points[next_i],
            top_points[next_i],
            top_points[i]
        ]

        # Add the side face
        mesh.add_face(quad)

    # Try to create an ACIS body from the mesh
    body = acis.body_from_mesh(mesh)

    # Create a 3DSOLID entity
    solid3d = msp.add_3dsolid(dxfattribs={'layer': material, 'color': color})

    # Export the ACIS body to the 3DSOLID
    acis.export_dxf(solid3d, [body])

    # Try to force AutoCAD to recognize this as a true volume-bearing solid
    # Add extended entity data to indicate this is a volume solid
    solid3d.set_xdata('ACAD', [
        (1000, 'ACIS_SOLID'),  # String marker
        (1071, 1)  # Integer flag to indicate true solid
    ])

    return solid3d

except Exception as e:
    print(f"Error creating 3DSOLID: {str(e)}")
    return 0
Answered by mozman
on May 13, 2025
The ACIS support of ezdxf is very basic, don't expect full feature support. You are lucky if get your 3D data into AutoCAD and that's it and there is no advantage over using MESH entities directly.

If you need better 3D support you have to use an OpenCascade base library or application like

build123d
FreeCAD (scriptable in Python)
But now you have different problem, none of the free and open source libraries and applications support ACIS import/export. So you have to use simple mesh based formats like STL or 3MF for import/export. Or you find a way to process BREP or STEP files. None of the solutions is ideal.

View full answer 
Replies:1 comment

mozman
on May 13, 2025
Maintainer
The ACIS support of ezdxf is very basic, don't expect full feature support. You are lucky if get your 3D data into AutoCAD and that's it and there is no advantage over using MESH entities directly.

If you need better 3D support you have to use an OpenCascade base library or application like

build123d
FreeCAD (scriptable in Python)
But now you have different problem, none of the free and open source libraries and applications support ACIS import/export. So you have to use simple mesh based formats like STL or 3MF for import/export. Or you find a way to process BREP or STEP files. None of the solutions is ideal.
```