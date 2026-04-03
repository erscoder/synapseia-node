FROM node:20-slim

# Install Python3 + pip + build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install node deps
COPY package.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Install PyTorch CPU-only in a separate layer (cached separately)
# Uses --break-system-packages for Debian bookworm compatibility
RUN pip3 install --no-cache-dir --break-system-packages \
    torch==2.2.2+cpu \
    --extra-index-url https://download.pytorch.org/whl/cpu

# Create data dir for datasets/brain
RUN mkdir -p /root/.synapseia

ENV NODE_ENV=production

# Run the Synapseia node CLI
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
