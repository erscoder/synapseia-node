FROM node:20-alpine

# Install Python3 + pip + PyTorch CPU (for training work orders)
RUN apk add --no-cache python3 py3-pip && \
    pip3 install --no-cache-dir torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu 2>/dev/null || \
    pip3 install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

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
