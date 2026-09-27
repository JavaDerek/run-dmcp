FROM node:20-slim

WORKDIR /app

# Copy package files for server
COPY package*.json ./

# Install production dependencies first
RUN npm ci --only=production

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Copy client files
COPY client/package*.json ./client/
COPY client/tsconfig*.json ./client/
COPY client/vite.config.ts ./client/
COPY client/index.html ./client/
COPY client/src ./client/src
COPY client/public ./client/public

# Install dev dependencies for build, build everything, then clean up
RUN npm install typescript && \
    cd client && npm ci && cd .. && \
    npm run build && \
    npm prune --production && \
    rm -rf src tsconfig.json client/src client/node_modules client/package*.json client/tsconfig*.json client/vite.config.ts client/index.html client/public

# Create data directory for SQLite
RUN mkdir -p /app/data

# Set environment
ENV NODE_ENV=production

# MCP is served over stdio. The web viewer (JSON API, SSE and the SPA) binds
# DMCP_HTTP_PORT, 3456 by default, unless DMCP_NO_HTTP is set; publish it with
# `-p 3456:3456` when you want the viewer, and set DMCP_NO_HTTP=1 when you do not.
EXPOSE 3456
ENTRYPOINT ["node", "dist/bin/run-dmcp.js"]
