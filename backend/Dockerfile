# CampusPulse API — Node 20 on Alpine.
#
# Build context is this backend/ directory:
#   docker build -t campuspulse-api ./backend
#   docker run --rm -p 8787:8787 -v campuspulse-data:/data campuspulse-api
#
# All config is env-driven (see backend/.env.example). With no DATABASE_URL the
# app uses the JSON store at DATABASE_PATH, which is why /data is a volume — so
# the data survives replacing the container. Point DATABASE_URL at Postgres/RDS
# (with DATABASE_SSL=true) to use a managed database instead.

# --- install production deps in a separate layer for caching ---------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- runtime ---------------------------------------------------------------
FROM node:20-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/campuspulse.json
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The JSON store lives on the mounted volume; make it writable by the
# unprivileged node user the image already ships.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787

# Liveness without adding curl to the image: a tiny Node probe against the
# app's own /api/health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD \
  node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
