FROM node:20-slim

# Install Python3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip curl\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install node deps
COPY package.json ./
RUN npm install

# Copy pre-built dist from host (skips expensive tsup build inside Docker)
COPY dist ./dist

# Copy remaining source (needed at runtime for dynamic imports in some modules)
COPY src ./src
COPY scripts ./scripts

# Install PyTorch (matching pre-built version) + numpy (required dependency)
RUN pip3 install --no-cache-dir --break-system-packages torch numpy

# Create data dir for datasets/brain
RUN mkdir -p /root/.synapseia

ENV NODE_ENV=production

# Run the Synapseia node CLI
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
