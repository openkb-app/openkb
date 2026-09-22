# Self-hosting

The stack ships as two images — `openkb-drupal` (Drupal on FrankenPHP, with drush) and `openkb-frontend` (the built Nuxt server with the embedded collaboration server) — next to the official `mariadb:11.4` and `opensearchproject/opensearch:3` images. `docker-compose.yml` is that stack; every setting is an environment variable, listed in [`.env.example`](../.env.example).

## Prerequisites

- Docker with the compose plugin.
- Two DNS names under one parent domain, both pointing at the host: one for the frontend (`kb.example.com`), one for Drupal (`cms.kb.example.com`). Drupal under a path of the frontend host is not supported.
- `vm.max_map_count=262144` on the host, for OpenSearch: `sysctl -w vm.max_map_count=262144`, and the same line in `/etc/sysctl.conf` to keep it.
- A reverse proxy that terminates TLS — your own, or the bundled Caddy overlay below.
- The OpenKB recipes. The image ships without them (ADR 0007): mount them into `drupal` next to `/app/recipes` and name the directory in `OPENKB_RECIPES_DIR`, e.g. `./recipes:/app/openkb-recipes:ro` with `OPENKB_RECIPES_DIR=/app/openkb-recipes`.

## Bring-up

```sh
cp .env.example .env              # the two URLs, the cookie domain, the secrets
docker compose build              # builds openkb-drupal and openkb-frontend from this checkout
docker compose up -d
docker compose exec drupal openkb-install
```

`openkb-install` installs the site, applies the recipes, provisions the collaboration server's OAuth client from `OKB_COLLAB_CLIENT_ID` / `OKB_COLLAB_CLIENT_SECRET` and sets the `admin` password from `ADMIN_PASSWORD` — or generates one and prints it. It destroys an existing site. After changing the images, `docker compose exec drupal openkb-update` runs the database updates, imports config when the sync directory holds an export, and rebuilds caches; it is safe to run twice.

Both services listen on plain HTTP, bound to `127.0.0.1`: `drupal` on `DRUPAL_HTTP_PORT` (8080), `frontend` on `FRONTEND_HTTP_PORT` (3000).

## The reverse proxy

Whatever proxy sits in front has to:

- forward each hostname to its port, and set `X-Forwarded-Proto` and `X-Forwarded-Host` — Drupal trusts them from the addresses in `REVERSE_PROXY_ADDRESSES`;
- upgrade WebSocket connections on `/collaboration` of the frontend host;
- allow at least 300 s idle on the frontend host: the collaboration server pings every 60 s.

Both services call each other under their public URLs, so the two names must also resolve from inside the containers — true for public DNS, and the Caddy overlay adds the in-network aliases itself.

**Caddy (bundled).** `docker-compose.tls.yml` adds `caddy:2-alpine` on ports 80/443 with automatic certificates; [`docker/tls/Caddyfile`](../docker/tls/Caddyfile) is the whole configuration. Set `FRONTEND_HOST` and `DRUPAL_HOST` in `.env`, then:

```sh
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

**Traefik** (labels on a `docker-compose.override.yml`; `websecure` and `le` are your entrypoint and resolver):

```yaml
services:
  frontend:
    labels:
      - traefik.enable=true
      - traefik.http.routers.okb-frontend.rule=Host(`kb.example.com`)
      - traefik.http.routers.okb-frontend.entrypoints=websecure
      - traefik.http.routers.okb-frontend.tls.certresolver=le
      - traefik.http.services.okb-frontend.loadbalancer.server.port=3000
  drupal:
    labels:
      - traefik.enable=true
      - traefik.http.routers.okb-drupal.rule=Host(`cms.kb.example.com`)
      - traefik.http.routers.okb-drupal.entrypoints=websecure
      - traefik.http.routers.okb-drupal.tls.certresolver=le
      - traefik.http.services.okb-drupal.loadbalancer.server.port=8080
```

Traefik upgrades WebSockets on its own; raise `--entrypoints.websecure.transport.respondingTimeouts.idleTimeout` to `300s`.

**nginx** (one `server` block per hostname; shown for the frontend, Drupal is the same without the `/collaboration` location and with port 8080):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /collaboration {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

**Cloudflare Tunnel** (`config.yml` of `cloudflared`; WebSockets pass through, the idle timeout is Cloudflare's 100 s, above the 60 s ping):

```yaml
ingress:
  - hostname: kb.example.com
    service: http://localhost:3000
  - hostname: cms.kb.example.com
    service: http://localhost:8080
  - service: http_status:404
```

## Volumes and backup

| Volume | Holds |
|---|---|
| `mariadb-data` | the database |
| `drupal-files` | `/app/files`: public and private files, the config sync directory, the OAuth keys |
| `collab-store` | the collaboration server's snapshot store: edits not yet saved to Drupal |
| `opensearch-data` | the search index — rebuildable: `drush search-api:reset-tracker kb_chunks && drush search-api:index kb_chunks` |

Back up the database, `drupal-files` and `collab-store` together, and restore them together: the snapshot store is coupled to the database ([ADR 0008](docs/adr/0008-store-coupled-to-database.md)). `docker compose down && docker compose up -d` keeps all four; `docker compose down -v` deletes them.

## Resources and logs

Idle, freshly installed: `opensearch` ~670 MB with a 256 MB heap (the default heap is 512 MB, `OPENSEARCH_JAVA_OPTS`), `mariadb` ~110 MB, `frontend` ~45 MB, `drupal` ~40 MB. Plan for 2 GB of RAM and 5 GB of disk for the images.

All four services log to stdout: `docker compose logs -f drupal` (Caddy's access and error log as JSON lines, PHP errors among them), `frontend`, `mariadb`, `opensearch`. Drupal's own log is at `/admin/reports/dblog`.

## Hosting the collaboration server

The Hocuspocus server is embedded in the Nitro process (decision: [OKB-11](https://drunomics.youtrack.cloud/issue/OKB-11); split-out triggers live there). How the integration works — components, connection flow, storage model, shutdown paths — is documented in [collab-server.md](collab-server.md). Constraints for any hosted / containerized deploy:

- **Exactly 1 replica of `frontend`.** Y.Doc state is held in-process — a second replica split-brains every open document. Never scale the frontend horizontally, never enable Nitro's `node-cluster` preset (WS is unsupported there, nitro#2171), and don't set a Nitro `baseURL` on node-server (breaks WS upgrades, nitro#2347). Re-open the split-out decision before adding replicas.
- **Persistent volume for the SQLite snapshot.** `frontend/var/` (or wherever `HOCUSPOCUS_SQLITE` points) is the only crash-safe copy of uncommitted edits and must live on a persistent volume — the `collab-store` volume in `docker-compose.yml`. When we go multi-env, the designated replacement is `@hocuspocus/extension-database` reusing the project DB; SQLite stays fine as long as we run single-replica. Note the 4.x `extension-sqlite` requires the `better-sqlite3` peer dep — coordinate versions with the hocuspocus bump (OKB-8).
- **`OKB_COLLAB_CLIENT_ID` / `OKB_COLLAB_CLIENT_SECRET` on both `frontend` and `drupal`.** The collaboration server's own OAuth client (ADR 0001): `frontend` presents it at `/oauth/token` and carries the Bearer token on every checkpoint, seed, conversation statement and client registration it relays; the PHP side provisions the consumer from the same pair (`scripts/setup-collab-oauth.sh`). They have no committed default — set them in `.env` — and without them the server has no identity: checkpoints report `no-credentials` and registration answers `temporarily_unavailable`. Holding them means being able to write as the collaboration server, so treat them as secrets. See [collab-server.md](collab-server.md), "The checkpoint's carrier and its statement".
- **Proxy idle timeouts above 60s.** Hocuspocus pings every 60s, which is borderline against a proxy that cuts idle connections at 60s — allow well above that, e.g. 300s, on the frontend host. If a CDN sits in front, check its idle timeout too (typically 90s) or bypass it for `/collaboration`.
- **Liveness probe**: `GET /api/collab/health` returns `{status, documents, connections, uptime}` from the embedded server — unauthenticated, aggregate counts only. It is the `openkb-frontend` image's healthcheck; reuse it for any hosted probe.
- **Shutdown flush**: pending debounced document stores are flushed to SQLite before the process dies. Production (`node .output/server/index.mjs`) gets this via nitro's graceful shutdown → `close` hook; dev containers wrap the server in `frontend/scripts/dev-server.sh` (see `docker-compose.development.yml`), because `nuxt dev` runs nitro in a worker thread that never sees SIGTERM.
