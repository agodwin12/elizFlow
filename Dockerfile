# ── ElizFlow API — production image (multi-stage) ──────────────────
# Node 22 (Prisma 7 requires Node >= 22).

# ── Stage 1: builder — install deps (incl. native bcrypt) + gen client ──
FROM node:22-alpine AS builder
WORKDIR /app

# Build toolchain for native addons (bcrypt) on musl/alpine.
RUN apk add --no-cache python3 make g++

# Install ALL dependencies (dev deps include tsx runtime + prisma CLI).
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma.config.ts ./
RUN npm install --no-audit --no-fund --loglevel=error

# Generate the Prisma client.
COPY prisma/ ./prisma/
RUN npx prisma generate

# ── Stage 2: runtime — lean image without the build toolchain ──────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy installed deps (with compiled native modules + generated client) and app.
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY prisma/ ./prisma/
COPY src/ ./src/

# The Firebase service account is provided at runtime via a bind mount
# (see docker-compose.yml). Copy it too if present in the build context
# (the [n] glob makes it optional so the build never fails when absent).
COPY firebase-service-account.jso[n] ./

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 11000

# busybox (bundled in alpine) provides wget for the health probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:11000/health || exit 1

# Signal handling / zombie reaping via Docker's built-in init (compose: init: true).
CMD ["npx", "tsx", "src/index.ts"]
