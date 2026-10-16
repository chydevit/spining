# PharmKulen Spin — production image (used by Render and docker compose).
FROM node:22-alpine

# Time-zone data so TZ=Asia/Phnom_Penh gives correct "per day" limits and daily stats.
RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000

WORKDIR /app

# Install production dependencies first so this layer is cached between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

# Local data folder (only used when DATABASE_URL is not set).
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server.js"]
