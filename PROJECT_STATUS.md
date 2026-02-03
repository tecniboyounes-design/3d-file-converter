# 3D File Converter - Project Status

**Last Updated:** February 2, 2026

---

## 📋 Overview

A web-based 3D file converter that supports multiple CAD and mesh formats, using a combination of open-source tools.

---

## 🛠️ Current Architecture

### Conversion Tools Stack

| Tool | Purpose | Formats |
|------|---------|---------|
| **Assimp** | Fast mesh conversion | OBJ, STL, PLY, FBX, glTF, GLB |
| **Blender 4.0.2** | Complex conversions, DXF (2D) | All mesh + DXF (lines/polylines) |
| **ODA File Converter** | DWG ↔ DXF conversion | DWG, DXF |
| **FreeCAD** | CAD format handling (fallback) | DXF, STEP, IGES |

### Conversion Pipeline

```
                    ┌─────────────┐
                    │  Input File │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐   ┌────────┐   ┌────────┐
         │  DWG   │   │  DXF   │   │  Mesh  │
         └───┬────┘   └───┬────┘   └───┬────┘
             │            │            │
             ▼            │            │
        ┌─────────┐       │            │
        │   ODA   │       │            │
        │ DWG→DXF │       │            │
        └────┬────┘       │            │
             │            │            │
             └─────┬──────┘            │
                   ▼                   │
            ┌────────────┐             │
            │  Blender   │◄────────────┤
            │ (try first)│             │
            └─────┬──────┘             │
                  │                    │
           ┌──────┴──────┐             │
           │   Failed?   │             │
           └──────┬──────┘             │
                  ▼                    │
            ┌────────────┐             │
            │  FreeCAD   │             │
            │ (fallback) │             │
            └─────┬──────┘             │
                  │                    │
                  └────────┬───────────┘
                           ▼
                    ┌─────────────┐
                    │   Assimp    │
                    │(final mesh) │
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │ Output File │
                    └─────────────┘
```

---

## ✅ What's Working

### Mesh Conversions (100% Working)

| From | To | Tool | Status |
|------|----|------|--------|
| OBJ | GLB, FBX, STL, PLY | Assimp | ✅ |
| STL | GLB, OBJ, FBX, PLY | Assimp | ✅ |
| PLY | GLB, OBJ, STL, FBX | Assimp | ✅ |
| FBX | GLB, OBJ, STL | Blender | ✅ |
| GLTF/GLB | OBJ, STL, FBX | Assimp/Blender | ✅ |

### DWG/DXF Conversions (Partial)

| From | To | Tool | Status |
|------|----|------|--------|
| DXF (2D lines) | GLB, OBJ, STL | Blender | ✅ |
| DWG | DXF | ODA | ✅ |
| DXF | DWG | ODA | ✅ |
| OBJ | DWG | Blender → ODA | ✅ |

---

## ❌ Current Problem: ACIS 3DSOLID

### The Issue

DXF/DWG files containing **ACIS 3DSOLID** entities cannot be converted.

**Test Files:**
- `tests/Nourdine DXF from Odoo.dxf`
- `tests/Nourdine Odoo.dwg`

**Error Returned:**
```json
{
  "error": true,
  "message": "DXF file contains 3DSOLID (ACIS) entities that cannot be converted",
  "code": "CONVERSION_ERROR"
}
```

### Why It Fails

**ACIS** (Alan, Charles, Ian's System) is a proprietary 3D modeling kernel owned by **Spatial Corp** (Dassault Systèmes).

| Tool | Can Read ACIS 3DSOLID? |
|------|------------------------|
| Blender | ❌ No |
| FreeCAD | ❌ No |
| Assimp | ❌ No |
| OpenCASCADE | ❌ No |
| ODA File Converter | ❌ No (only converts DWG↔DXF format) |

**Root Cause:** ACIS stores 3D solid geometry in a proprietary binary format (SAT/SAB) embedded in the DXF file. Reading this format requires licensing the ACIS SDK.

### DXF File Structure

```
Line 2300: ENTITIES
Line 2302: 3DSOLID    ← This is the problem
           ... binary ACIS data ...
```

---

## 🔧 Potential Solutions

### Solution 1: Autodesk Platform Services API (Recommended)

Autodesk owns ACIS technology and their cloud API can convert these files.

**Pros:**
- Works with ACIS solids ✅
- Supports 60+ CAD formats
- Free tier: 100 conversions/month

**Cons:**
- Requires internet connection
- API keys required
- Slight latency (cloud processing)

**Implementation:** Add as fallback when local tools fail

### Solution 2: Change Export at Source

Configure Odoo to export as:
- **STEP** (.step/.stp) - Open standard
- **IGES** (.iges/.igs) - Open standard  
- **STL/OBJ** - Mesh format

### Solution 3: Commercial SDK

- **Teigha SDK** (~$2000+/year)
- **CAD Exchanger** (commercial license)

---

## 📁 Key Files Modified

### Backend

| File | Purpose |
|------|---------|
| `server/src/modules/conversion/conversion.route.ts` | API endpoint, multipart parsing |
| `server/src/modules/conversion/conversion.service.ts` | Routing logic, fallback handling |
| `server/src/modules/conversion/providers/freecad.provider.ts` | FreeCAD integration |
| `server/src/modules/conversion/providers/index.ts` | Provider exports |

### Scripts

| File | Purpose |
|------|---------|
| `scripts/freecad/export.py` | FreeCAD Python conversion script |
| `scripts/blender/export.py` | Blender Python conversion script |

### Docker

| File | Purpose |
|------|---------|
| `Dockerfile` | Installs Blender, Assimp, ODA, FreeCAD |

---

## 🚀 Next Steps

1. **Option A:** Integrate Autodesk API as fallback for ACIS files
2. **Option B:** Work with Odoo team to export STEP/STL instead
3. **Option C:** Document limitation and provide clear user guidance

---

## 🧪 Testing Commands

```bash
# Start server
docker compose up -d

# Test OBJ → GLB (works)
curl -X POST http://localhost:3001/api/convert \
  -F "file=@tests/Hackney Sofa.obj" \
  -F "format=glb"

# Test DXF with ACIS → GLB (fails with clear error)
curl -X POST http://localhost:3001/api/convert \
  -F "file=@tests/Nourdine DXF from Odoo.dxf" \
  -F "format=glb"

# Check logs
docker compose logs backend --tail=50
```
