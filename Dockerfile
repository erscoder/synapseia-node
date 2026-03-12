FROM node:20-alpine AS builder

WORKDIR /app

# Install build deps
RUN apk add --no-cache python3 py3-pip curl bash

# Copy package files
COPY package.json tsconfig.json ./
RUN npm install

# Copy source and build
COPY src/ ./src/
RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 py3-pip curl bash

# Install Ollama
RUN curl -fsSL https://ollama.ai/install.sh | sh || true

# Copy built artifacts + deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create data dir for identity/keypair persistence
RUN mkdir -p /app/data

# Expose inference server port
EXPOSE 8080

# Entrypoint: start node in agent mode
CMD ["node", "dist/index.cjs", "start"]
