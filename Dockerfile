# syntax=docker/dockerfile:1
# One Dockerfile, two images:  docker build --target tracksync .   /   --target tracker .

# ---------- build everything once ----------
FROM node:24-alpine AS build
WORKDIR /src
RUN apk add --no-cache zip
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/content/package.json packages/content/
COPY services/tracksync/package.json services/tracksync/
COPY services/tracker/package.json services/tracker/
COPY apps/extension/package.json apps/extension/
COPY apps/reader/package.json apps/reader/
# The desktop app's Electron binary isn't needed to build the servers.
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w services/tracksync \
 && npm run build -w services/tracker \
 && npm run build -w apps/extension

# ---------- shared runtime: just Node + a bundled file ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
# su-exec lets the entrypoint drop root and run as PUID:PGID (see deploy/docker-entrypoint.sh).
RUN apk add --no-cache su-exec \
 && echo '{"type":"module"}' > package.json && mkdir -p /data && chown node:node /data
COPY --chmod=755 deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV PUID=1000 PGID=1000
VOLUME /data
ENTRYPOINT ["docker-entrypoint.sh"]

# ---------- TrackSync: accounts + sync API + web dashboard ----------
FROM runtime AS tracksync
COPY --from=build --chown=node:node /src/services/tracksync/dist ./
ENV PORT=8080 DB_PATH=/data/tracksync.db
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server.js"]

# ---------- Tracker: rate-limited AO3 gateway + metadata cache ----------
FROM runtime AS tracker
COPY --from=build --chown=node:node /src/services/tracker/dist ./
# Serve the browser extension so it's easy to grab from any device on your network.
COPY --from=build --chown=node:node /src/apps/extension/dist/ao3track-extension-2.0.0.zip ./downloads/
ENV PORT=8081 DB_PATH=/data/tracker.db DOWNLOADS_DIR=/app/downloads
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
