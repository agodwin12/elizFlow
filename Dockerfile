# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma.config.ts ./

# Install all dependencies (including dev for tsx)
RUN npm install

# Copy source code and required files
COPY src/ ./src/
COPY prisma/ ./prisma/
COPY firebase-service-account.json ./

# Generate Prisma client
RUN npx prisma generate

EXPOSE 11000

# Start with tsx (same as you do locally)
CMD ["npx", "tsx", "src/index.ts"]