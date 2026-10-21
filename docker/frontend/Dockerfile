# syntax=docker/dockerfile:1
# openkb-frontend: the built Nuxt server with the embedded collab server, on :3000.

FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS base

# - npm 11 resolves the musl optional dependencies npm 10 drops.
# - curl serves the healthcheck and scripts/dev-server.sh.
RUN apk add --no-cache curl \
 && npm install -g npm@11.19.1 \
 && rm -rf /root/.npm

WORKDIR /app/frontend


FROM base AS build

# The collab store's sqlite binding compiles where no musl prebuild exists.
RUN apk add --no-cache g++ make python3

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY frontend ./
RUN npm run build


FROM base

COPY --from=build /app/frontend/.output .output
COPY frontend/scripts scripts
COPY --chmod=755 docker/frontend/entrypoint.sh /usr/local/bin/openkb-frontend-entrypoint

# - var/ holds the collab snapshot store.
# - node_modules/ is the mount point of the development overlay's volume, which
#   whatever uid the host user has must be able to fill.
RUN mkdir var node_modules && chown node:node var && chmod 1777 node_modules

ENV NODE_ENV=production

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${NITRO_PORT:-${NUXT_PORT:-3000}}/api/collab/health" || exit 1

ENTRYPOINT ["openkb-frontend-entrypoint"]
CMD ["node", ".output/server/index.mjs"]

# Last, so a new revision rebuilds no layer above.
ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="openkb-frontend" \
      org.opencontainers.image.description="OpenKB frontend: the Nuxt server with the embedded Hocuspocus collaboration server." \
      org.opencontainers.image.source="https://github.com/openkb-app/openkb" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
