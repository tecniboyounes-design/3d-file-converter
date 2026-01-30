# Task 02: ODA File Converter Integration

## 📋 Task Overview

| Field | Value |
|-------|-------|
| **Task ID** | TASK-02 |
| **Priority** | 🔴 CRITICAL |
| **Estimated Time** | 1 day |
| **Dependencies** | Task 01 (Docker Optimization) |
| **Blocks** | DWG support |
| **Status** | ✅ COMPLETED |

## 🎯 Objectives

1. ✅ Install ODA File Converter in Docker image
2. ✅ Configure xvfb for headless execution
3. ✅ Verify ODA works via command line
4. ✅ Test DWG ↔ DXF conversions manually

> ⚠️ **NOTE:** We do NOT write the Node.js wrapper in this task!
> The TypeScript version will be written in **Task 04** to avoid rewriting JS → TS.

---

## ✅ Prerequisites

- [x] Task 01 completed (Docker Optimization)
- [x] Docker image builds successfully
- [x] Understanding of ODA CLI syntax

---

## 📝 Implementation (Actual)

### What was implemented:

1. **ODA File Converter 26.12** installed via DEB package
2. **xvfb + xauth** for headless execution
3. **libxcb-shape0** and other Qt dependencies for xcb platform plugin
4. **libxcb-util.so.0 symlink** per official ODA docs for modern Linux
5. **oda-convert wrapper script** at `/usr/local/bin/oda-convert`

### Key Dependencies Added:
```
libxcb-util1, libxcb-icccm4, libxcb-image0, libxcb-keysyms1,
libxcb-render-util0, libxcb-xinerama0, libxcb-xkb1, libxcb-shape0,
libxkbcommon-x11-0, libegl1, libgl1, libdbus-1-3, xauth
```

### Final Dockerfile Section:
```dockerfile
# ============================================================
# INSTALL ODA FILE CONVERTER
# ============================================================
# ODA requires QT libraries and a display (even for CLI)
# We use xvfb to provide a virtual framebuffer

# Download and install ODA File Converter
# NOTE: Check https://www.opendesign.com/guestfiles for latest version
ARG ODA_VERSION=25.3
RUN curl -L -o /tmp/oda.deb \
    "https://download.opendesign.com/guestfiles/ODAFileConverter/ODAFileConverter_QT6_lnxX64_8.3dll_${ODA_VERSION}.deb" \
    && dpkg -i /tmp/oda.deb || apt-get install -f -y \
    && rm /tmp/oda.deb \
    && rm -rf /var/lib/apt/lists/*

# Verify ODA installation
RUN which ODAFileConverter && echo "ODA File Converter installed successfully"

# Create wrapper script for ODA (runs with xvfb)
RUN echo '#!/bin/bash\nxvfb-run -a ODAFileConverter "$@"' > /usr/local/bin/oda-convert \
    && chmod +x /usr/local/bin/oda-convert
```

### Step 2: Verify ODA Installation (Shell Test)

> ⚠️ **SKIP WRITING NODE.JS WRAPPER** - We'll write the TypeScript version in Task 04.
> For now, just verify ODA works from the command line.

```bash
# Enter the container
docker run -it --rm 3d-converter:with-oda /bin/bash

# Inside container, verify ODA is installed
which ODAFileConverter
# Should output: /usr/bin/ODAFileConverter

# Test with xvfb (required for headless)
xvfb-run -a ODAFileConverter --help
# Should show ODA help text

# Create test directories
mkdir -p /tmp/oda_test/input /tmp/oda_test/output

# If you have a test DWG file, copy it to /tmp/oda_test/input/
# Then run:
xvfb-run -a ODAFileConverter /tmp/oda_test/input /tmp/oda_test/output ACAD2018 DXF 0 1

# Check output
ls -la /tmp/oda_test/output/
```

### Step 3: (REFERENCE ONLY) ODA Provider Logic

This code will be implemented in **Task 04** as TypeScript. 
Keep this as reference for understanding ODA's quirks:

```javascript
// REFERENCE ONLY - DO NOT CREATE THIS FILE
// This shows the key concepts for ODA integration:
//
// 1. ODA requires DIRECTORIES (not files) as input/output
// 2. ODA requires xvfb-run for headless execution
// 3. We must create temp directories and clean them up

// ODA requires input/output to be DIRECTORIES, not files
// So we need to create temp directories for each conversion

/**
 * Convert DWG to DXF or DXF to DWG using ODA File Converter
 * 
 * @param {string} inputFilePath - Full path to input file
 * @param {string} outputFormat - 'DXF' or 'DWG'
 * @param {Object} options - Optional settings
 * @param {string} options.version - AutoCAD version (default: 'ACAD2018')
 * @returns {Promise<string>} - Path to converted file
 */
async function odaConvert(inputFilePath, outputFormat, options = {}) {
  const { version = 'ACAD2018' } = options;
  
  // Validate input
  const inputExt = path.extname(inputFilePath).toLowerCase();
  if (!['.dwg', '.dxf'].includes(inputExt)) {
    throw new Error(`ODA only supports DWG and DXF files. Got: ${inputExt}`);
  }
  
  if (!['DXF', 'DWG'].includes(outputFormat.toUpperCase())) {
    throw new Error(`ODA output format must be DXF or DWG. Got: ${outputFormat}`);
  }

  // ODA requires directories, not individual files
  const inputDir = path.dirname(inputFilePath);
  const inputFileName = path.basename(inputFilePath);
  const outputFileName = inputFileName.replace(inputExt, `.${outputFormat.toLowerCase()}`);
  
  // Create a temporary output directory
  const tempOutputDir = path.join(inputDir, `oda_output_${Date.now()}`);
  await fs.ensureDir(tempOutputDir);

  // Create a temporary input directory with just our file
  const tempInputDir = path.join(inputDir, `oda_input_${Date.now()}`);
  await fs.ensureDir(tempInputDir);
  await fs.copy(inputFilePath, path.join(tempInputDir, inputFileName));

  return new Promise((resolve, reject) => {
    console.log(`[ODA] Converting ${inputFileName} to ${outputFormat}`);
    console.log(`[ODA] Input dir: ${tempInputDir}`);
    console.log(`[ODA] Output dir: ${tempOutputDir}`);

    // Use xvfb-run to provide a virtual display
    const proc = spawn('xvfb-run', [
      '-a',  // Auto-select display number
      'ODAFileConverter',
      tempInputDir,    // Input folder
      tempOutputDir,   // Output folder
      version,         // Output version (ACAD2018, ACAD2013, etc.)
      outputFormat.toUpperCase(),  // DXF or DWG
      '0',             // Recurse input folder: 0 = no
      '1'              // Audit: 1 = yes (fix errors)
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log(`[ODA stdout] ${data}`);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      console.error(`[ODA stderr] ${data}`);
    });

    proc.on('error', (err) => {
      // Cleanup temp directories
      fs.remove(tempInputDir).catch(() => {});
      fs.remove(tempOutputDir).catch(() => {});
      reject(new Error(`ODA process error: ${err.message}`));
    });

    proc.on('close', async (code) => {
      console.log(`[ODA] Process exited with code ${code}`);

      // Cleanup input temp directory
      await fs.remove(tempInputDir).catch(() => {});

      if (code !== 0) {
        await fs.remove(tempOutputDir).catch(() => {});
        reject(new Error(`ODA conversion failed with code ${code}. Stderr: ${stderr}`));
        return;
      }

      // Find the output file
      const outputFilePath = path.join(tempOutputDir, outputFileName);
      
      if (await fs.pathExists(outputFilePath)) {
        // Move output file to original input directory
        const finalOutputPath = path.join(inputDir, outputFileName);
        await fs.move(outputFilePath, finalOutputPath, { overwrite: true });
        
        // Cleanup output temp directory
        await fs.remove(tempOutputDir).catch(() => {});
        
        console.log(`[ODA] Conversion successful: ${finalOutputPath}`);
        resolve(finalOutputPath);
      } else {
        // List what files were created (for debugging)
        const files = await fs.readdir(tempOutputDir).catch(() => []);
        console.error(`[ODA] Expected ${outputFileName}, found: ${files.join(', ')}`);
        
        await fs.remove(tempOutputDir).catch(() => {});
        reject(new Error(`ODA conversion completed but output file not found. Expected: ${outputFileName}`));
      }
    });
  });
}

/**
 * Convert DWG to DXF
 * @param {string} dwgPath - Path to DWG file
 * @returns {Promise<string>} - Path to DXF file
 */
async function dwgToDxf(dwgPath) {
  return odaConvert(dwgPath, 'DXF');
}

/**
 * Convert DXF to DWG
 * @param {string} dxfPath - Path to DXF file
 * @returns {Promise<string>} - Path to DWG file
 */
async function dxfToDwg(dxfPath) {
  return odaConvert(dxfPath, 'DWG');
}

/**
 * Check if ODA File Converter is available
 * @returns {Promise<boolean>}
 */
async function isOdaAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('which', ['ODAFileConverter']);
    proc.on('close', (code) => {
      resolve(code === 0);
    });
    proc.on('error', () => {
      resolve(false);
    });
  });
}

// Key function signature (for Task 04):
// async function odaConvert(inputFilePath, outputFormat, options)
//   - Creates temp input/output directories
//   - Copies file to temp input dir
//   - Runs: xvfb-run -a ODAFileConverter <inputDir> <outputDir> ACAD2018 <DXF|DWG> 0 1
//   - Moves output file back
//   - Cleans up temp dirs in finally{} block
```

### ~~Step 3: Create Test Script~~ (MOVED TO TASK 04)

> The test script will be created in Task 04 alongside the TypeScript provider.

### Step 4: Manual Test with Sample File (Optional)

```javascript
/**
 * Test script for ODA File Converter
 * Run: node scripts/test-oda.js
 */

const path = require('path');
const fs = require('fs-extra');
const { odaConvert, isOdaAvailable, dwgToDxf } = require('../server/providers/oda.provider');

async function main() {
  console.log('=== ODA File Converter Test ===\n');

  // Check if ODA is available
  const available = await isOdaAvailable();
  console.log(`ODA Available: ${available ? '✅ Yes' : '❌ No'}`);
  
  if (!available) {
    console.error('\nODA File Converter is not installed or not in PATH.');
    console.error('Make sure you are running inside the Docker container.');
    process.exit(1);
  }

  // Check for test file
  const testDir = path.join(process.cwd(), 'data', 'test');
  const testDwg = path.join(testDir, 'sample.dwg');
  
  if (!await fs.pathExists(testDwg)) {
    console.log(`\nNo test file found at ${testDwg}`);
    console.log('Please place a sample.dwg file in data/test/ directory');
    console.log('\nAlternatively, create a simple test:');
    console.log('1. Enter container: docker exec -it <container> bash');
    console.log('2. Run: node scripts/test-oda.js');
    return;
  }

  try {
    console.log(`\nConverting: ${testDwg}`);
    const outputPath = await dwgToDxf(testDwg);
    console.log(`\n✅ SUCCESS! Output: ${outputPath}`);
    
    // Verify output exists
    const exists = await fs.pathExists(outputPath);
    console.log(`Output file exists: ${exists ? '✅' : '❌'}`);
    
    if (exists) {
      const stats = await fs.stat(outputPath);
      console.log(`Output file size: ${stats.size} bytes`);
    }
  } catch (error) {
    console.error('\n❌ FAILED:', error.message);
    process.exit(1);
  }
}

main();
```

### Step 5: Update Dockerfile with Complete ODA Section

Update your Dockerfile to ensure all dependencies are present:

```dockerfile
# Add these packages to the apt-get install command if not already present:
    # For ODA File Converter (QT6 dependencies)
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libice6 \
    libgl1 \
    libegl1 \
    libxkbcommon0 \
    libdbus-1-3 \
    # Virtual framebuffer (CRITICAL for ODA)
    xvfb \
```

### Step 6: Build and Test

```bash
# Rebuild Docker image with ODA
docker build -t 3d-converter:with-oda .

# Check image size (should still be < 700MB)
docker images 3d-converter:with-oda

# Run container interactively
docker run -it --rm \
  -v $(pwd)/data:/usr/src/app/data \
  3d-converter:with-oda \
  /bin/bash

# Inside container, verify everything:
which ODAFileConverter      # Should show path
which blender               # Should show path  
which assimp                # Should show path (assimp-utils)
xvfb-run -a ODAFileConverter --help  # Should show ODA help

# Exit container
exit
```

---

## 🧪 Testing Checklist

### Installation
- [ ] ODA File Converter binary exists at `/usr/bin/ODAFileConverter`
- [ ] xvfb is installed
- [ ] `xvfb-run -a ODAFileConverter --help` works

### Manual Shell Test
- [ ] Can run ODA from command line with xvfb-run
- [ ] If test DWG available: DWG → DXF works manually
- [ ] Output files are created in output directory

> ⚠️ **Node.js integration will be tested in Task 04**

---

## ✅ Acceptance Criteria

| Criteria | Target | Status |
|----------|--------|--------|
| ODA installed in Docker | Yes | ⬜ |
| xvfb-run works | Yes | ⬜ |
| Manual DWG → DXF test | Yes (if file available) | ⬜ |
| Docker image < 700MB | Yes | ⬜ |

> ⚠️ **Provider module and error handling will be done in Task 04**

---

## 🐛 Troubleshooting

### Issue: "cannot open display" error
**Solution:** Use `xvfb-run -a` prefix:
```bash
xvfb-run -a ODAFileConverter /input /output ACAD2018 DXF 0 1
```

### Issue: ODA not found
**Solution:** Check installation:
```bash
which ODAFileConverter
dpkg -l | grep -i oda
```

### Issue: Missing QT libraries
**Solution:** Install additional dependencies:
```bash
apt-get install -y libqt6core6 libqt6gui6 libqt6widgets6
```

### Issue: Conversion runs but no output file
**Solution:** 
1. Check ODA expects DIRECTORIES not files
2. Verify input/output directories exist
3. Check for ODA error messages in stderr

### Issue: "Segmentation fault" during conversion
**Solution:** This usually means missing dependencies. Try:
```bash
ldd /usr/bin/ODAFileConverter | grep "not found"
```

---

## 📊 ODA CLI Reference

```bash
ODAFileConverter <input_folder> <output_folder> <output_version> <output_type> <recurse> <audit>
```

| Parameter | Values | Description |
|-----------|--------|-------------|
| input_folder | path | Directory containing input files |
| output_folder | path | Directory for output files |
| output_version | ACAD9, ACAD2000, ACAD2010, ACAD2018 | AutoCAD version format |
| output_type | DXF, DWG, DXB | Output file format |
| recurse | 0, 1 | Process subdirectories |
| audit | 0, 1 | Audit and fix errors |

---

## 🔗 Related Files

- `Dockerfile` - ODA installation (only file modified in this task)

> ⚠️ **`oda.provider.ts` will be created in Task 04**

---

## ⏭️ Next Task

After completing this task, proceed to: **[Task 03: Fastify Migration](./task-03-fastify-migration.md)**
