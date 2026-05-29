# Synapseia Node — multi-stage image.
#
# Two stages so nobody can accidentally ship a stale host-built `dist/` again:
#   1. builder: full deps + tsup build straight from `src/`
#   2. runtime: slim image with prod deps + the freshly built dist
#
# Node 24 is required by libp2p v3 (uses `Promise.withResolvers`).
# On Node 20 `p2pService.createNode()` throws and the entire gossip stack
# (heartbeat, chat auction, chat stream) silently stays off.
#
# Supply-chain: this image uses pnpm with the committed lockfile and
# `--ignore-scripts`, mirroring `.github/workflows/publish-npm.yml`. Full
# `npm install` (which executes every transitive postinstall hook — the exact
# vector abused by Shai-Hulud-style attacks) is BANNED. We skip lifecycle
# scripts, then run only the trusted steps explicitly: `patch-package` for our
# vendored patches and `pnpm rebuild` for the allowlisted native deps.
#
# NOTE: this Dockerfile cannot be validated by a local build in the dev
# sandbox (no Docker). The real image build/verification happens in CI.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app

# pnpm via corepack (pinned by the package's `packageManager` field upstream;
# corepack resolves the right version from the lockfile metadata).
RUN corepack enable

# Full deps (dev included — tsup lives there). Keep this layer cacheable by
# copying only the manifest + lockfile first; src changes don't re-trigger
# the install layer.
#
# `--ignore-scripts` skips ALL lifecycle hooks (preinstall/postinstall/prepare)
# of every dependency — supply-chain hardening. `--frozen-lockfile` aborts if
# pnpm-lock.yaml would change, guaranteeing a reproducible install.
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --ignore-scripts

# `--ignore-scripts` above skipped our own `postinstall: patch-package`, so run
# it explicitly. This applies ONLY our trusted vendored patches under patches/
# (e.g. @libp2p+utils onProgress recursion guard); third-party postinstall
# scripts stay skipped.
RUN pnpm exec patch-package

# Rebuild only the allowlisted native deps (matches `pnpm.onlyBuiltDependencies`
# in the root workspace manifest). `|| true` tolerates a dep not being present
# in this package's tree.
RUN pnpm rebuild esbuild @swc/core || true

# Source + build config → compile with tsup
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json tsup.config.ts ./
RUN pnpm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-slim

# Python + pip for the PyTorch training path + curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

# Prod deps only — keeps the runtime image small. Same supply-chain flags as
# the builder: frozen lockfile + no lifecycle scripts. `--prod` omits devDeps.
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# Apply our vendored patches to the prod tree as well (prod deps include the
# patched @libp2p/utils). Trusted patch-package only; no third-party scripts.
RUN pnpm exec patch-package

# Freshly built dist from the builder stage + runtime-only source needed by
# dynamic imports in some modules.
COPY --from=builder /app/dist ./dist
COPY src ./src
COPY scripts ./scripts

# PyTorch + numpy for the training worker. Installed into an isolated venv with
# PINNED versions (no `--break-system-packages` smearing into the system
# interpreter, no unpinned floating versions that drift the image build to
# build). Pins live in `requirements-training.txt` next to this Dockerfile.
COPY requirements-training.txt ./
RUN python3 -m venv /opt/training-venv \
    && /opt/training-venv/bin/pip install --no-cache-dir -r requirements-training.txt
# Put the venv first on PATH so the training worker's `python3` resolves to it.
ENV PATH="/opt/training-venv/bin:${PATH}"

RUN mkdir -p /root/.synapseia

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
