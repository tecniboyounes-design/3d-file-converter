# syntax=docker/dockerfile:1

#
# ---- Base Image (Ubuntu 22.04)
#
FROM ubuntu:22.04

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

#
# ---- Install Blender & Dependencies
#
RUN apt-get update \
  && apt-get install -y \
    curl \
    blender \
    python3-numpy \
    ca-certificates \
    gnupg \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

RUN echo "BLENDER Version Installed:" && blender --version

#
# ---- Install Node.js (Version 20 LTS)
#
RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN echo "NODE Version Installed:" && node --version
RUN echo "NPM Version Installed:" && npm --version

#
# ---- Build & Setup App
#
WORKDIR /usr/src/app

# 1. Copy root package files
COPY package.json package-lock.json ./
RUN npm ci

# 2. Copy Client & Server Code
COPY client ./client
COPY server ./server
COPY scripts ./scripts

# 3. Build Frontend
WORKDIR /usr/src/app/client
RUN npm ci
RUN npm run build
# The build output is now in /usr/src/app/client/dist

# 4. Return to Root
WORKDIR /usr/src/app

# Set production env
ENV NODE_ENV=production
ENV PORT=3001

# Expose the port
EXPOSE 3001

# Start the server directly
CMD ["npm", "run", "start:prod"]