# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Create data directory for identity and tokens
RUN mkdir -p /app/data

# Set environment defaults
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV MCP_TRANSPORT=http
ENV MCP_PORT=3000

# Expose port for HTTP transport
EXPOSE 3000

CMD ["node", "dist/index.js"]
