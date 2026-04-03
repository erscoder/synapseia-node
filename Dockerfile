FROM node:20-slim

# Install Python3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip curl\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install node deps
COPY package.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Install PyTorch (CPU only, no CUDA) + numpy for tensor operations
RUN pip3 install --no-cache-dir --break-system-packages \
    torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cpu \
    && pip3 install --no-cache-dir --break-system-packages numpy

# Create data dir for datasets/brain
RUN mkdir -p /root/.synapseia

ENV NODE_ENV=production

# Run the Synapseia node CLI
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
