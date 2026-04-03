FROM node:20-slim

# Install Python3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install PyTorch CPU-only (arm64 compatible)
RUN pip3 install --no-cache-dir --break-system-packages \
    torch --index-url https://download.pytorch.org/whl/cpu

WORKDIR /app

# Copy package files and install deps
COPY package.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Create data dir for datasets/brain
RUN mkdir -p /root/.synapseia

ENV NODE_ENV=production

# Run the Synapseia node CLI
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
