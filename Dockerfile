# ============================================
# Stage 1: Build librespot from source
# ============================================
FROM rust:1.85-slim AS librespot-builder

# libasound2-dev is needed for the default rodio-backend (uses cpal/ALSA)
RUN apt-get update && \
    apt-get install -y pkg-config libasound2-dev && \
    rm -rf /var/lib/apt/lists/*

# Build with single job to fit in Railway's memory limits
# The pipe backend is always compiled in (no feature flag needed)
ENV CARGO_BUILD_JOBS=1
RUN cargo install librespot --locked

# ============================================
# Stage 2: Node.js application
# ============================================
FROM node:20-slim

# libasound2 is needed at runtime for the linked ALSA symbols
RUN apt-get update && \
    apt-get install -y libasound2 && \
    rm -rf /var/lib/apt/lists/*

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
