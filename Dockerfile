# Multi-stage build for synapse-node
# Stage 1: Dependencies
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files
COPY packages/node/package.json packages/node/package-lock.json* ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY packages/node ./

# Build TypeScript
RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S synapse && \
    adduser -S synapse -u 1001

# Copy built files
COPY --from=builder --chown=synapse:synapse /app/dist ./dist
COPY --from=builder --chown=synapse:synapse /app/node_modules ./node_modules
COPY --from=deps --chown=synapse:synapse /app/package.json ./

# Create directories for runtime
RUN mkdir -p /app/data && \
    chown synapse:synapse /app/data

USER synapse

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Set environment
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:$PATH"

# Expose inference server port
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
