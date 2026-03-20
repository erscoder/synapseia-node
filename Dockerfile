FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy built CLI
COPY . .

# Create synapse config directory
RUN mkdir -p /root/.synapse

# Set environment variables
ENV NODE_ENV=production

RUN npm run build

# Run the SynapseIA node CLI
ENTRYPOINT ["node", "dist/index.cjs"]
CMD ["start"]
