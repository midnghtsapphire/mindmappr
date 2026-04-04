FROM node:20-slim

# Install build tools for better-sqlite3 native compilation + Python for node-gyp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
    && pip3 install --break-system-packages reportlab openpyxl requests beautifulsoup4 matplotlib \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./
# If pnpm-lock exists, copy it too (but we'll use npm)
COPY pnpm-lock.yaml* ./

# Install dependencies with npm (handles better-sqlite3 native build)
RUN npm install --production

# Copy application code
COPY . .

# Create data and uploads directories
RUN mkdir -p data uploads

# Expose the port
EXPOSE 3005

# Start the app
CMD ["node", "server.mjs"]
