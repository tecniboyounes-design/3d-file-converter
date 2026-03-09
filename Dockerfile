# syntax=docker/dockerfile:1
#
# Optimized 3D File Converter
# Supports: OBJ, STL, FBX, PLY, glTF, GLB, DAE, 3DS, DXF, DWG, STEP, IGES, IFC
# Platform: linux/amd64 (runs on Apple Silicon via Rosetta, native on x86_64 Linux)

# ============================================================
# STAGE 0: IfcOpenShell source (for IfcConvert binary + libs)
# ============================================================
FROM --platform=linux/amd64 aecgeeks/ifcopenshell:v0.8.0 AS ifcopenshell-source

# ============================================================
# STAGE 1: FreeCAD library extraction
# Install full FreeCAD, then extract ONLY the libraries we need.
# This saves ~1.2GB vs installing freecad in the runtime stage.
# ============================================================
FROM --platform=linux/amd64 debian:bookworm-slim AS freecad-extract
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends freecad \
    && rm -rf /var/lib/apt/lists/*

# Extract FreeCAD core modules + Python modules + shared library deps
RUN set -e && mkdir -p /fc/lib/freecad/lib /fc/share /fc/deps \
    #
    # FreeCAD core .so modules - resolve symlink chain:
    # /usr/lib/freecad/lib -> /etc/alternatives/freecadlib -> /usr/lib/freecad-python3/lib
    && cp -L /usr/lib/freecad/lib/*.so /fc/lib/freecad/lib/ \
    && cp -rL /usr/lib/freecad/Ext /fc/lib/freecad/Ext 2>/dev/null || true \
    && cp -rL /usr/lib/freecad/bin /fc/lib/freecad/bin 2>/dev/null || true \
    #
    # Also copy the core FreeCAD shared libraries (libFreeCADApp.so, etc.)
    && cp -L /usr/lib/freecad-python3/lib/lib*.so* /fc/lib/freecad/lib/ 2>/dev/null || true \
    #
    # FreeCAD Python modules (Draft/importDXF, Part, Mesh, Ext)
    && cp -a /usr/share/freecad /fc/share/freecad \
    #
    # Collect shared library deps (2 passes for transitive deps)
    # Exclude base system libs that exist in debian:bookworm-slim
    && SKIP='libc\.so\|libm\.so\|libpthread\|librt\.so\|libdl\.so\|libstdc\|libgcc_s\|ld-linux\|libz\.so\|libresolv\|libnss\|libnsl\|libcrypt' \
    && for _pass in 1 2; do \
         find /fc/lib -name '*.so*' -type f -exec ldd {} + 2>/dev/null \
         | grep '=> /' | awk '{print $3}' | sort -u | grep -v "$SKIP" \
         | while read -r lib; do \
             bn=$(basename "$lib"); \
             [ ! -f "/fc/deps/$bn" ] && cp -L "$lib" "/fc/deps/" 2>/dev/null || true; \
           done; \
       done

# ============================================================
# STAGE 2: Node.js application builder
# ============================================================
FROM --platform=linux/amd64 node:20-slim AS builder

WORKDIR /app

# Build frontend
COPY client ./client
WORKDIR /app/client
RUN npm ci && npm run build

# Build server, then prune dev dependencies
WORKDIR /app
COPY server ./server
WORKDIR /app/server
RUN npm ci && npm run build && npm prune --omit=dev

# ============================================================
# STAGE 3: Production runtime (optimized)
# ============================================================
FROM --platform=linux/amd64 debian:bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive

# Copy Node.js binary from builder (saves ~140MB vs separate nodesource install)
COPY --from=builder /usr/local/bin/node /usr/local/bin/

# ALL system packages + Blender + ODA + Python packages in ONE layer
ARG BLENDER_VERSION=4.0.2
ARG ODA_VERSION=27.1
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Display/rendering libs (Blender + ODA shared deps)
    libgl1-mesa-glx libgl1 libegl1 libxi6 libxrender1 libxkbcommon0 \
    libxxf86vm1 libxfixes3 libxinerama1 libfontconfig1 libfreetype6 \
    libsm6 libice6 libglib2.0-0 libxext6 libdbus-1-3 \
    # XCB libs (ODA Qt6 deps)
    libxcb-util1 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
    libxcb-render-util0 libxcb-xinerama0 libxcb-xkb1 libxcb-shape0 \
    libxkbcommon-x11-0 \
    # Virtual framebuffer for headless rendering
    xvfb xauth \
    # Assimp 3D format converter
    assimp-utils \
    # Python runtime + pip (pip purged after install)
    python3 python3-pip \
    # System libs for IfcOpenShell (libsz2 needed by HDF5 for IfcConvert)
    libxml2 libmpfr6 libgmp10 libtbb12 libtbbmalloc2 libsz2 \
    # PySide2 for FreeCAD DXF import/export (Draft module dependency)
    python3-pyside2.qtcore python3-pyside2.qtgui python3-pyside2.qtwidgets \
    # Utilities
    curl ca-certificates xz-utils \
    \
    # ---- Install Blender portable binary ----
    && curl -sL "https://download.blender.org/release/Blender4.0/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
       | tar -xJ -C /opt/ \
    && ln -s "/opt/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/local/bin/blender \
    # Strip Blender: remove locales, tests, caches (~250MB savings)
    && rm -rf "/opt/blender-${BLENDER_VERSION}-linux-x64/4.0/datafiles/locale" \
              "/opt/blender-${BLENDER_VERSION}-linux-x64/4.0/python/lib/python3.10/test" \
              "/opt/blender-${BLENDER_VERSION}-linux-x64/4.0/python/lib/python3.10/ensurepip" \
              "/opt/blender-${BLENDER_VERSION}-linux-x64/license" \
              "/opt/blender-${BLENDER_VERSION}-linux-x64/readme.html" \
    && find "/opt/blender-${BLENDER_VERSION}-linux-x64" \( -name '__pycache__' -o -name '*.pyc' \) -exec rm -rf {} + 2>/dev/null; true \
    \
    # ---- Install ODA File Converter ----
    && curl -fsSL -o /tmp/oda.deb \
       "https://www.opendesign.com/guestfiles/get?filename=ODAFileConverter_QT6_lnxX64_8.3dll_${ODA_VERSION}.deb" \
    && (dpkg -i /tmp/oda.deb || apt-get install -f -y --no-install-recommends) \
    && rm -f /tmp/oda.deb \
    \
    # ---- Python packages (with no cache) ----
    && pip3 install --no-cache-dir --break-system-packages numpy ifcopenshell ezdxf olefile \
    \
    # ---- Cleanup: purge build-only tools, remove caches ----
    && apt-get purge -y python3-pip \
    && apt-get autoremove -y --purge \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/* \
       /usr/share/doc /usr/share/man /usr/share/info /usr/share/lintian \
    # ODA compatibility symlink
    && ln -sf /usr/lib/x86_64-linux-gnu/libxcb-util.so.1 /usr/lib/x86_64-linux-gnu/libxcb-util.so.0

# ---- FreeCAD: minimal extracted libraries (saves ~1.2GB) ----
# Paths match what Python scripts expect (/usr/lib/freecad/lib, /usr/share/freecad/Mod/*)
COPY --from=freecad-extract /fc/lib/freecad /usr/lib/freecad
COPY --from=freecad-extract /fc/share/freecad /usr/share/freecad
# Isolated deps dir (loaded via LD_LIBRARY_PATH to avoid OCCT conflicts with IfcOpenShell)
COPY --from=freecad-extract /fc/deps /opt/freecad/deps

# ---- IfcOpenShell: binary + isolated shared libs ----
COPY --from=ifcopenshell-source /usr/bin/IfcConvert /usr/local/bin/IfcConvert.bin
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libTK*.so.7 /opt/ifcopenshell/lib/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libhdf5_serial*.so* /opt/ifcopenshell/lib/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libboost_program_options.so* /opt/ifcopenshell/lib/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libboost_regex.so* /opt/ifcopenshell/lib/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libtbb*.so* /opt/ifcopenshell/lib/
COPY --from=ifcopenshell-source /lib/x86_64-linux-gnu/libicu*.so* /opt/ifcopenshell/lib/

# ---- Wrapper scripts ----
RUN printf '#!/bin/bash\nxvfb-run -a /usr/bin/ODAFileConverter "$@"\n' > /usr/local/bin/oda-convert \
    && chmod +x /usr/local/bin/oda-convert \
    #
    # FreeCAD wrapper: loads isolated OCCT deps via LD_LIBRARY_PATH
    && printf '#!/bin/bash\nexport QT_QPA_PLATFORM=offscreen\nexport FREECAD_USER_HOME=/tmp/freecad\nmkdir -p /tmp/freecad\nexport LD_LIBRARY_PATH=/opt/freecad/deps:$LD_LIBRARY_PATH\nxvfb-run -a python3 "$@"\n' > /usr/local/bin/freecad-convert \
    && chmod +x /usr/local/bin/freecad-convert \
    #
    # IfcConvert wrapper: loads isolated IfcOpenShell deps
    && printf '#!/bin/bash\nLD_LIBRARY_PATH=/opt/ifcopenshell/lib:$LD_LIBRARY_PATH exec /usr/local/bin/IfcConvert.bin "$@"\n' \
       > /usr/local/bin/IfcConvert && chmod +x /usr/local/bin/IfcConvert \
    && ldconfig

# ---- Application ----
WORKDIR /usr/src/app
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY scripts ./scripts
COPY package.json ./
RUN mkdir -p data/uploads && chmod 755 data/uploads

# ---- Environment ----
ENV NODE_ENV=production \
    PORT=3001 \
    MAX_CONCURRENT_BLENDER=2 \
    MAX_CONCURRENT_ASSIMP=5 \
    CONVERSION_TIMEOUT=300000

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:3001/ready | grep -q '"status":"ready"' || exit 1

CMD ["node", "server/dist/server.js"]
