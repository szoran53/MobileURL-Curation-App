# ---------------------------------------------------------------------------
# Stage 1 (builder): install production deps and build the NATIVE
# better-sqlite3 module (needs a C toolchain). Only this stage has build
# tools; the runtime below is a slim image with none of them.
# ---------------------------------------------------------------------------
FROM node:20-bookworm AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
# --omit=dev keeps only runtime deps (better-sqlite3, express, dotenv).
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 (runtime): slim glibc image, production node_modules from stage 1,
# app source, and a fixed /data path for the SQLite DB (mounted from the host).
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server.js"]
