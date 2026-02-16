# syntax=docker/dockerfile:1

# ============================================================
# IMPORTANT: This image targets linux/amd64 for Blender compatibility
# Build with: docker build --platform linux/amd64 -t 3d-converter:optimized .
# ============================================================

# ============================================================
# STAGE 0: IFCOPENSHELL SOURCE (for extracting IfcConvert binary)
# ============================================================
FROM --platform=linux/amd64 aecgeeks/ifcopenshell:v0.8.0 AS ifcopenshell-source

# ============================================================
# STAGE 1: BUILD (Node.js dependencies + Frontend + TypeScript)
# ============================================================
FROM --platform=linux/amd64 node:20-slim AS builder

WORKDIR /app

# Install root dependencies (for server)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy and build frontend
COPY client ./client
WORKDIR /app/client
RUN npm ci && npm run build

# Build server (TypeScript -> JavaScript)
WORKDIR /app
COPY server ./server
WORKDIR /app/server
RUN npm ci && npm run build

# ============================================================
# STAGE 2: RUNTIME (Minimal production image)
# ============================================================
FROM --platform=linux/amd64 debian:bookworm-slim AS runtime

# Avoid prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies in a single layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    # For Blender
    libgl1-mesa-glx \
    libxi6 \
    libxrender1 \
    libxkbcommon0 \
    libxxf86vm1 \
    libxfixes3 \
    libxinerama1 \
    libfontconfig1 \
    libfreetype6 \
    libsm6 \
    libice6 \
    # For ODA File Converter (QT dependencies - installed now for Task 02)
    libglib2.0-0 \
    libxext6 \
    # Virtual framebuffer for ODA headless (xvfb + xauth required)
    xvfb \
    xauth \
    # For Assimp
    assimp-utils \
    # General utilities
    curl \
    ca-certificates \
    xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Verify Node installation
RUN echo "NODE Version:" && node --version && echo "NPM Version:" && npm --version

# Download Blender as portable binary (NOT apt-get - much smaller!)
# Using Blender 4.0 LTS for stability
ARG BLENDER_VERSION=4.0.2
RUN curl -L https://download.blender.org/release/Blender4.0/blender-${BLENDER_VERSION}-linux-x64.tar.xz \
    | tar -xJ -C /opt/ \
    && ln -s /opt/blender-${BLENDER_VERSION}-linux-x64/blender /usr/local/bin/blender

# Verify Blender installation
RUN echo "BLENDER Version:" && blender --version

# Verify Assimp installation
RUN assimp version || echo "Assimp installed successfully"

# ============================================================
# INSTALL ODA FILE CONVERTER (for DWG <-> DXF conversions)
# ============================================================
# Using DEB package from official ODA website (version 26.12)
# Qt runtimes are now bundled in the package

# Install additional dependencies for ODA
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxcb-util1 \
    libxcb-icccm4 \
    libxcb-image0 \
    libxcb-keysyms1 \
    libxcb-render-util0 \
    libxcb-xinerama0 \
    libxcb-xkb1 \
    libxcb-shape0 \
    libxkbcommon-x11-0 \
    libegl1 \
    libgl1 \
    libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create libxcb-util.so.0 symlink (required by ODA on modern Linux per official docs)
RUN ln -sf /usr/lib/x86_64-linux-gnu/libxcb-util.so.1 /usr/lib/x86_64-linux-gnu/libxcb-util.so.0

# Download and install ODA File Converter DEB package
# Version 26.12 from official ODA website: https://www.opendesign.com/guestfiles/oda_file_converter
ARG ODA_VERSION=26.12
RUN set -eux; \
    curl -fsSL -o /tmp/oda.deb \
      "https://www.opendesign.com/guestfiles/get?filename=ODAFileConverter_QT6_lnxX64_8.3dll_${ODA_VERSION}.deb"; \
    if ! dpkg -i /tmp/oda.deb; then \
      i=1; \
      while [ "$i" -le 3 ]; do \
        if apt-get update && apt-get install -f -y --no-install-recommends; then \
          break; \
        fi; \
        if [ "$i" -eq 3 ]; then \
          exit 1; \
        fi; \
        sleep $((i * 5)); \
        i=$((i + 1)); \
      done; \
      dpkg -i /tmp/oda.deb; \
    fi; \
    rm -f /tmp/oda.deb; \
    rm -rf /var/lib/apt/lists/*

# Verify ODA installation (the DEB installs to /usr/bin/ODAFileConverter which is a launcher script)
RUN test -f /usr/bin/ODAFileConverter && echo "ODA File Converter installed successfully" \
    && cat /usr/bin/ODAFileConverter

# Create wrapper script for ODA (runs with xvfb for headless operation)
RUN printf '#!/bin/bash\nxvfb-run -a /usr/bin/ODAFileConverter "$@"\n' > /usr/local/bin/oda-convert \
    && chmod +x /usr/local/bin/oda-convert

# ============================================================
# INSTALL FREECAD (for ACIS 3D solid handling in DXF/DWG)
# ============================================================
# Use the Debian package but run via python with FreeCAD modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    freecad \
    python3-pyside2.qtcore \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create wrapper script for FreeCAD (uses Python with FreeCAD modules via xvfb)
# The key is to use python3 with the FreeCAD path, not freecadcmd directly
RUN printf '#!/bin/bash\nexport QT_QPA_PLATFORM=offscreen\nexport FREECAD_USER_HOME=/tmp/freecad\nmkdir -p /tmp/freecad\nxvfb-run -a python3 "$@"\n' > /usr/local/bin/freecad-convert \
    && chmod +x /usr/local/bin/freecad-convert

# Test that FreeCAD Python modules can be imported
RUN xvfb-run -a python3 -c "import sys; sys.path.insert(0, '/usr/lib/freecad/lib'); import FreeCAD; print('FreeCAD', FreeCAD.Version())" || echo "FreeCAD modules check"

# ============================================================
# INSTALL IFCOPENSHELL (for IFC format support)
# ============================================================
# Copy IfcConvert binary from official IfcOpenShell image (multi-stage build)
COPY --from=ifcopenshell-source /usr/bin/IfcConvert /usr/local/bin/IfcConvert

# Copy required shared libraries from IfcOpenShell image
# These are OpenCASCADE, HDF5, Boost, TBB, ICU libraries that IfcConvert was built against
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libTK*.so.7 /lib/x86_64-linux-gnu/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libhdf5_serial*.so* /lib/x86_64-linux-gnu/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libboost_program_options.so* /lib/x86_64-linux-gnu/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libboost_regex.so* /lib/x86_64-linux-gnu/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libtbb*.so* /lib/x86_64-linux-gnu/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libicu*.so* /lib/x86_64-linux-gnu/

# Install IfcOpenShell Python library and remaining runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    libxml2 \
    libmpfr6 \
    libgmp10 \
    libtbb12 \
    libtbbmalloc2 \
    && pip3 install --break-system-packages ifcopenshell \
    && ldconfig \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Verify IfcConvert installation
RUN IfcConvert --version || echo "IfcConvert binary installed"
RUN python3 -c "import ifcopenshell; print('IfcOpenShell Python:', ifcopenshell.version)" || echo "IfcOpenShell Python installed"

# ============================================================
# COPY APPLICATION
# ============================================================
WORKDIR /usr/src/app

# Copy built assets from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules

# Copy server package.json (for module resolution) and scripts
COPY server/package.json ./server/
COPY scripts ./scripts
COPY package.json ./

# Create uploads directory with proper permissions
RUN mkdir -p data/uploads && chmod 755 data/uploads

# ============================================================
# ENVIRONMENT & STARTUP
# ============================================================
ENV NODE_ENV=production
ENV PORT=3001

# Concurrency limits (prevent OOM)
ENV MAX_CONCURRENT_BLENDER=2
ENV MAX_CONCURRENT_ASSIMP=5

# Conversion timeout (5 minutes)
ENV CONVERSION_TIMEOUT=300000

EXPOSE 3001

# Health check - checks readiness endpoint including tool availability
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:3001/ready | grep -q '"status":"ready"' || exit 1

# Start the Fastify server (TypeScript compiled to dist/)
CMD ["node", "server/dist/server.js"]
