# node 24 — required for `Promise.withResolvers` used by libp2p v3 + deps.
# Anything older fails at p2pService.createNode() with
# "Promise.withResolvers is not a function", the P2P layer stays off, and
# every chat auction resolves to ALL_BIDS_FAILED because the BidResponder
# subscribes through gossipsub. Local dev nodes should also stay on Node 22+.
FROM node:24-slim

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
