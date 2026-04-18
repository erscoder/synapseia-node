# Synapseia Node — multi-stage image.
#
# Two stages so nobody can accidentally ship a stale host-built `dist/` again:
#   1. builder: full deps + tsup build straight from `src/`
#   2. runtime: slim image with prod deps + the freshly built dist
#
# Node 24 is required by libp2p v3 (uses `Promise.withResolvers`).
# On Node 20 `p2pService.createNode()` throws and the entire gossip stack
# (heartbeat, chat auction, chat stream) silently stays off.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app

# Full deps (dev included — tsup lives there). Keep this layer cacheable by
# copying only package.json first; src changes don't re-trigger npm install.
COPY package.json ./
RUN npm install

# Source + build config → compile with tsup
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json tsup.config.ts ./
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-slim

# Python + pip for the PyTorch training path + curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prod deps only — keeps the runtime image small.
COPY package.json ./
RUN npm install --omit=dev

# Freshly built dist from the builder stage + runtime-only source needed by
# dynamic imports in some modules.
COPY --from=builder /app/dist ./dist
COPY src ./src
COPY scripts ./scripts

# PyTorch + numpy for the training worker (must match the pre-built version)
RUN pip3 install --no-cache-dir --break-system-packages torch numpy

RUN mkdir -p /root/.synapseia

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
