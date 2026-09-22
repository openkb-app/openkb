#!/bin/sh
# SIGTERM-safe wrapper for `nuxt dev` in containers (the development compose
# overlay runs `sh scripts/dev-server.sh` as the frontend command).
#
# Why it exists: `nuxt dev` runs the nitro app in a worker thread, and POSIX
# signals are only ever dispatched to the main thread — no in-process handler
# in server/plugins/hocuspocus.ts can see the SIGTERM from
# `docker compose stop`. This wrapper traps the signal and flushes pending
# Hocuspocus document stores via the loopback-only POST /api/collab/flush
# before the dev server dies, so edits inside the store-debounce window
# still reach the SQLite snapshot. The production entry
# (`node .output/server/index.mjs`) needs no wrapper: nitro's graceful
# shutdown runs the flush from the `close` hook.
set -u

PORT="${NUXT_PORT:-3000}"

# Reconciles node_modules with the checked-out lockfile; a ~5s no-op when they
# agree.
# - --include=dev: npm omits dev dependencies when NODE_ENV is `production`.
# - --no-save: the container consumes the lockfile, it never authors it.
npm install --include=dev --no-save --no-audit --no-fund || exit 1

./node_modules/.bin/nuxt dev --host 0.0.0.0 --port "$PORT" &
child=$!

flush_and_stop() {
  curl -sf -m 10 -X POST "http://127.0.0.1:${PORT}/api/collab/flush" >/dev/null 2>&1 \
    || echo "[dev-server.sh] collab flush failed (server not up?)" >&2
  kill -TERM "$child" 2>/dev/null
}
trap flush_and_stop TERM INT

# First wait returns when a trapped signal arrives; the second reaps the
# child after flush_and_stop has terminated it.
wait "$child" || true
wait "$child" 2>/dev/null || true
