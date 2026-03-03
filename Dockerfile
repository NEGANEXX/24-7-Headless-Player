# ============================================
# Single stage: Node.js + go-librespot binary
# ============================================
FROM node:20-slim

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y ca-certificates curl libasound2 && \
    rm -rf /var/lib/apt/lists/*

# Download go-librespot v0.7.1 prebuilt binary (no Rust compilation needed!)
RUN curl -L https://github.com/devgianlu/go-librespot/releases/download/v0.7.1/go-librespot_linux_x86_64.tar.gz \
    | tar -xz -C /usr/local/bin go-librespot && \
    chmod +x /usr/local/bin/go-librespot

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --production

# Copy config and application code
COPY go-librespot-config.yml /app/config/config.yml
COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
