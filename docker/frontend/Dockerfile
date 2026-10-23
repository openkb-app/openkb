# syntax=docker/dockerfile:1
# openkb-frontend: the built Nuxt server with the embedded collab server, on :3000.
#
# Stages:
# - build: npm 11 and a toolchain, builds .output.
# - release: the published image, without npm, corepack or yarn.
# - development: release plus npm, for docker-compose.development.yml.

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base

# curl serves the healthcheck and scripts/dev-server.sh.
RUN apk add --no-cache curl

WORKDIR /app/frontend


FROM base AS build

# - npm 11 resolves the musl optional dependencies npm 10 drops.
# - The collab store's sqlite binding compiles where no musl prebuild exists.
RUN apk add --no-cache g++ make python3 \
 && npm install -g npm@11.19.1 \
 && rm -rf /root/.npm

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY frontend ./
RUN npm run build


FROM base AS release

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build /app/frontend/.output .output
COPY frontend/scripts scripts
COPY --chmod=755 docker/frontend/entrypoint.sh /usr/local/bin/openkb-frontend-entrypoint

# var/ holds the collab snapshot store.
RUN mkdir var && chown node:node var

ENV NODE_ENV=production

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${NITRO_PORT:-${NUXT_PORT:-3000}}/api/collab/health" || exit 1

ENTRYPOINT ["openkb-frontend-entrypoint"]
CMD ["node", ".output/server/index.mjs"]


FROM release AS development

USER root

COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

# node_modules/ is the mount point of the overlay's volume, which whatever uid
# the host user has must be able to fill.
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && mkdir node_modules && chmod 1777 node_modules

USER node


FROM release

# Last, so a new revision rebuilds no layer above.
ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="openkb-frontend" \
      org.opencontainers.image.description="OpenKB frontend: the Nuxt server with the embedded Hocuspocus collaboration server." \
      org.opencontainers.image.source="https://github.com/openkb-app/openkb" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
