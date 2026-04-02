# syntax=docker/dockerfile:1

# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /build

# Workspace manifests and lock file
COPY package.json package-lock.json tsconfig.base.json ./

# Package sources
COPY packages/core/     packages/core/
COPY packages/centerdevice/ packages/centerdevice/

# Install only the two relevant workspaces (hoists shared deps to root node_modules)
RUN npm ci -w packages/core -w packages/centerdevice

# Compile
RUN npm run build -w packages/core && npm run build -w packages/centerdevice

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine

# Non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Shared node_modules (hoisted by npm workspaces)
COPY --from=builder /build/node_modules ./node_modules

# core package
COPY --from=builder /build/packages/core/dist     ./packages/core/dist
COPY --from=builder /build/packages/core/package.json ./packages/core/package.json

# centerdevice package
COPY --from=builder /build/packages/centerdevice/dist     ./packages/centerdevice/dist
COPY --from=builder /build/packages/centerdevice/package.json ./packages/centerdevice/package.json

USER app

WORKDIR /app/packages/centerdevice

EXPOSE 9443

CMD ["node", "dist/index.js"]
