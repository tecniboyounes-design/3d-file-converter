# Task 01: Docker Optimization

## 📋 Task Overview

| Field | Value |
|-------|-------|
| **Task ID** | TASK-01 |
| **Priority** | 🔴 CRITICAL |
| **Estimated Time** | 1-2 days |
| **Dependencies** | None (First task) |
| **Blocks** | All subsequent tasks |

## 🎯 Objectives

1. Reduce Docker image size from ~1.5-2GB to ~400-500MB
2. Switch from Ubuntu to Debian Slim base image
3. Implement multi-stage build
4. Download Blender binary instead of apt-get
5. Install Assimp utilities

---

## ✅ Prerequisites

- [ ] Docker installed and running
- [ ] Access to the project repository
- [ ] Basic understanding of Dockerfile syntax
- [ ] Internet connection (for downloading binaries)

---

## 📝 Step-by-Step Instructions

### Step 1: Backup Current Dockerfile

```bash
cp Dockerfile Dockerfile.backup
```

### Step 2: Create New Optimized Dockerfile

> ⚠️ **NOTE ON PACKAGE.JSON LOCATION:**
> - This task uses the **root** `package.json` (existing Express server)
> - In **Task 03**, we'll switch to `server/package.json` (new Fastify server)
> - The Dockerfile will need to be updated again in Task 03

Replace the entire content of `Dockerfile` with:

```dockerfile
# syntax=docker/dockerfile:1

# ============================================================
# STAGE 1: BUILD (Node.js dependencies + Frontend)
# ============================================================
FROM node:20-slim AS builder

WORKDIR /app

# Install root dependencies
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Build frontend
COPY client ./client
WORKDIR /app/client
RUN npm ci && npm run build

# ============================================================
# STAGE 2: RUNTIME (Minimal production image)
# ============================================================
FROM debian:bookworm-slim AS runtime

# Avoid prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies
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
    # For ODA File Converter (QT dependencies)
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libice6 \
    # Virtual framebuffer for ODA headless
    xvfb \
    # For Assimp
    assimp-utils \
    # General utilities
    curl \
    ca-certificates \
    wget \
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
RUN echo "ASSIMP Version:" && assimp version || echo "Assimp installed"

# ============================================================
# COPY APPLICATION
# ============================================================
WORKDIR /usr/src/app

# Copy built assets from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/client/dist ./client/dist

# Copy server and scripts
COPY server ./server
COPY scripts ./scripts
COPY package.json ./

# Create uploads directory
RUN mkdir -p data/uploads && chmod 777 data/uploads

# ============================================================
# ENVIRONMENT & STARTUP
# ============================================================
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Start the server
CMD ["node", "server/index.js"]
```

### Step 3: Update .dockerignore

Create or update `.dockerignore`:

```
# Dependencies
node_modules
client/node_modules

# Build outputs
client/dist

# Development files
.git
.gitignore
*.md
!README.md

# IDE
.vscode
.idea

# OS files
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Environment
.env
.env.local
.env.*.local

# Docker
Dockerfile*
docker-compose*

# Tasks and docs
tasks/
REFACTORING_PLAN.md

# Data (will be mounted as volume)
data/uploads/*
!data/uploads/.keep
```

### Step 4: Build and Test

```bash
# Build the optimized image
docker build -t 3d-converter:optimized .

# Check the image size
docker images 3d-converter:optimized

# Run the container
docker run -d \
  --name converter-test \
  -p 3001:3001 \
  -v $(pwd)/data:/usr/src/app/data \
  3d-converter:optimized

# Check logs
docker logs -f converter-test

# Test the server is running
curl http://localhost:3001/

# Stop and remove test container
docker stop converter-test && docker rm converter-test
```

### Step 5: Verify All Tools Work

```bash
# Enter the container
docker run -it --rm 3d-converter:optimized /bin/bash

# Inside container, test each tool:

# Test Blender
blender --version
blender --background --python-expr "import bpy; print('Blender OK')"

# Test Assimp
assimp version
assimp info --help

# Test Node
node --version
npm --version

# Exit container
exit
```

---

## 🧪 Testing Checklist

### Image Size
- [ ] Image size is under 600MB
- [ ] Image size is ideally under 500MB

### Tools Available
- [ ] `node --version` works
- [ ] `npm --version` works
- [ ] `blender --version` works
- [ ] `assimp version` works
- [ ] `curl --version` works

### Server Startup
- [ ] Server starts without errors
- [ ] Server responds on port 3001
- [ ] Health check endpoint works (once added)

### Conversion Test
- [ ] Upload a simple OBJ file
- [ ] Convert OBJ to GLB
- [ ] Download the converted file
- [ ] Verify the output is valid

---

## ✅ Acceptance Criteria

| Criteria | Target | Status |
|----------|--------|--------|
| Image size | < 600MB | ⬜ |
| Build time | < 10 minutes | ⬜ |
| Node.js available | v20.x | ⬜ |
| Blender available | v4.x | ⬜ |
| Assimp available | Any | ⬜ |
| Server starts | Yes | ⬜ |
| Basic conversion works | Yes | ⬜ |

---

## 🐛 Troubleshooting

### Issue: Blender fails with "libGL error"
**Solution:** Make sure `libgl1-mesa-glx` is installed.

### Issue: Image size still too large
**Solution:** 
1. Check for leftover apt cache: `rm -rf /var/lib/apt/lists/*`
2. Combine RUN commands to reduce layers
3. Use `--no-install-recommends` with apt-get

### Issue: Permission denied on /data/uploads
**Solution:** Add `RUN chmod 777 data/uploads` or run container with proper user.

### Issue: npm ci fails in builder stage
**Solution:** Make sure both `package.json` and `package-lock.json` exist.

---

## 📊 Expected Results

```
REPOSITORY          TAG         SIZE
3d-converter        optimized   ~450-550MB
3d-converter        current     ~1.5-2GB
```

**Size reduction: ~70%** 🎉

---

## 🔗 Related Files

- `Dockerfile` - Main file to modify
- `.dockerignore` - Exclusion patterns
- `docker-compose.yml` - May need updates

---

## ⏭️ Next Task

After completing this task, proceed to: **[Task 02: ODA Converter Integration](./task-02-oda-converter.md)**
