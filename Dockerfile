# syntax=docker/dockerfile:1

#
# ---- Base Image (Ubuntu 22.04)
FROM ubuntu:22.04

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

#
# ---- Install Blender & Dependencies
# Added 'python3-numpy' which is strictly required for the GLTF exporter
RUN apt-get update \
  && apt-get install -y \
    curl \
    blender \
    python3-numpy \
    ca-certificates \
    gnupg \
  && rm -rf /var/lib/apt/lists/*

RUN echo "BLENDER Version Installed:" && blender --version

#
# ---- Install Node.js (Version 20 LTS)
RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN echo "NODE Version Installed:" && node --version
RUN echo "NPM Version Installed:" && npm --version

#
# ---- Custom Logic

# Prepare directory structure
WORKDIR /usr/src/app

# Install app dependencies
COPY package.json package-lock.json ./

# 'npm ci' is faster and more reliable for builds than 'npm i'
RUN npm ci --only=production

# ENTRYPOINT ["/bin/bash"]npm