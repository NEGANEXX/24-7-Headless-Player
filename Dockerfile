# ============================================
# Stage 1: Build librespot from source
# ============================================
FROM rust:1.85-slim AS librespot-builder

RUN apt-get update && \
    apt-get install -y pkg-config && \
    rm -rf /var/lib/apt/lists/*

# Build with single job to fit in Railway's 1GB RAM
ENV CARGO_BUILD_JOBS=1
RUN cargo install librespot --no-default-features --features pipe

# ============================================
# Stage 2: Node.js application
# ============================================
FROM node:20-slim

# Copy librespot binary from builder
COPY --from=librespot-builder /usr/local/cargo/bin/librespot /usr/local/bin/librespot

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Railway sets PORT automatically via env var
EXPOSE 3000

# Start the application
CMD ["node", "src/index.js"]

