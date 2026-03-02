# ============================================
# Stage 1: Build librespot from source
# ============================================
FROM rust:1.85-slim AS librespot-builder

RUN apt-get update && \
    apt-get install -y pkg-config && \
    rm -rf /var/lib/apt/lists/*

# Build librespot with only pipe backend (no audio libraries needed)
RUN cargo install librespot --no-default-features --features pipe-backend

# ============================================
# Stage 2: Node.js application
# ============================================
FROM node:20-slim

# Copy librespot binary from builder
COPY --from=librespot-builder /usr/local/cargo/bin/librespot /usr/local/bin/librespot

# Verify librespot works
RUN librespot --version || echo "librespot installed"

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Create directory for token persistence
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/api/status || exit 1

# Start the application
CMD ["node", "src/index.js"]
