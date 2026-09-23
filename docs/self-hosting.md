# Self-hosting

The stack ships as two images — `openkb-drupal` (Drupal on FrankenPHP, with drush; the `cron` service runs the same image with supercronic, `drush cron` every five minutes) and `openkb-frontend` (the built Nuxt server with the embedded collaboration server) — next to the official `mariadb:11.4` and `opensearchproject/opensearch:3` images. `docker-compose.yml` is that stack; every setting is an environment variable, listed in [`.env.example`](../.env.example).

Both images are published to GHCR per release; [`release.md`](release.md) covers pinning a version instead of building from this checkout.

## Evaluating on a laptop

Everything below describes a real host. To just look at OpenKB, run the evaluation stack instead and skip the rest of this page: two files, no hostnames, no secrets, described in [`quickstart/README.md`](../quickstart/README.md).

## Prerequisites

- Docker with the compose plugin.
- Two DNS names under one parent domain, both pointing at the host: one for the frontend (`kb.example.com`), one for Drupal (`admin.kb.example.com`). Drupal under a path of the frontend host is not supported.
- `vm.max_map_count=262144` on the host, for OpenSearch: `sysctl -w vm.max_map_count=262144`, and the same line in `/etc/sysctl.conf` to keep it. Keep memory mapping on for a real index; `OPENSEARCH_ALLOW_MMAP=false` drops the requirement at the cost of read performance, which is a trade for evaluation, not for production.
- A reverse proxy that terminates TLS; Caddy and Traefik examples below.

## Bring-up

```sh
cp .env.example .env              # the two URLs, the cookie domain, the secrets
docker compose build              # builds openkb-drupal and openkb-frontend from this checkout
docker compose up -d
```

The `drupal` container installs the site on its first boot: the install state the image carries, the collaboration server's OAuth client from `OKB_COLLAB_CLIENT_ID` / `OKB_COLLAB_CLIENT_SECRET`, and the `admin` password from `ADMIN_PASSWORD` — or a generated one, printed to the container log. Both services answer with a "setting up" page (`503`, `Retry-After`) until the install is through, and `docker compose logs -f drupal` carries it. A restart of an installed site reinstalls nothing.

`docker compose exec drupal openkb-install` is the manual re-install; it destroys the site it finds.

## Updating

```sh
docker compose pull
docker compose up -d
```

Where the new images bring database updates, the site holds itself until they have been run: maintenance mode with a message naming `update.php`, cron paused, and the "setting up" page on the frontend. Updates are never run unattended — back up first (below), then:

1. sign in at `https://admin.kb.example.com/user/login` as an account with *Administer software updates*,
2. open `https://admin.kb.example.com/update.php` and run what it lists.

From a shell instead, `docker compose exec drupal drush updatedb` runs the same updates; back up first either way.

Both ways end in a cache rebuild, and that is what lifts the hold.

Both services listen on plain HTTP, bound to `127.0.0.1`: `drupal` on `DRUPAL_HTTP_PORT` (8080), `frontend` on `FRONTEND_HTTP_PORT` (3000).

## The reverse proxy

Whatever proxy sits in front has to:

- forward each hostname to its port, and set `X-Forwarded-Proto` and `X-Forwarded-Host` — Drupal trusts them from the addresses in `REVERSE_PROXY_ADDRESSES`;
- upgrade WebSocket connections on `/collaboration` of the frontend host;
- allow at least 300 s idle on the frontend host: the collaboration server pings every 60 s.

Both services call each other under their public URLs, so the two names must also resolve from inside the containers — true for public DNS, and the Caddy overlay adds the in-network aliases itself.

**Caddy** (a complete configuration; Caddy sets the forwarded headers and passes WebSockets through by itself):

```caddyfile
kb.example.com {
	reverse_proxy 127.0.0.1:3000
}

admin.kb.example.com {
	reverse_proxy 127.0.0.1:8080
}
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
      - traefik.http.routers.okb-drupal.rule=Host(`admin.kb.example.com`)
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
  - hostname: admin.kb.example.com
    service: http://localhost:8080
  - service: http_status:404
```

## Volumes and backup

| Volume | Holds |
|---|---|
| `mariadb-data` | the database |
| `drupal-files` | `/app/files`: public and private files, the config sync directory, the OAuth keys, the `.openkb-installed` marker |
| `collab-store` | the collaboration server's snapshot store: edits not yet saved to Drupal |
| `opensearch-data` | the search index — rebuildable: `drush search-api:reset-tracker kb_chunks && drush search-api:index kb_chunks` |

Back up the database, `drupal-files` and `collab-store` together, and restore them together: the snapshot store is coupled to the database. `docker compose down && docker compose up -d` keeps all four; `docker compose down -v` deletes them.

A backup, from the checkout that holds the stack's `.env`. The frontend is stopped while its store is copied, so no edit lands in between:

```sh
mkdir -p backup
docker compose stop frontend
docker compose exec -T mariadb sh -c 'mariadb-dump --single-transaction -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' > backup/db.sql
docker compose exec -T drupal tar cz -C /app/files . > backup/drupal-files.tgz
docker compose run --rm --no-deps -T --entrypoint tar frontend cz -C /app/frontend/var . > backup/collab-store.tgz
docker compose start frontend
```

Restore is the reverse, into a stack whose `frontend` is stopped: the dump through `mariadb` (`mariadb -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE" < db.sql`), each archive with `tar xz` into the same directory of the same service. Then `docker compose start frontend` and `docker compose exec drupal drush cr`.

## Resources and logs

Host sizing and image sizes are in the [README](../README.md#requirements): 8 GB of RAM free for a production host. `OPENSEARCH_JAVA_OPTS` sets the OpenSearch heap; the image default is 512 MB, a production host gives it 1 GB or more (`-Xms1g -Xmx1g`).

All services log to stdout: `docker compose logs -f drupal` (Caddy's access and error log as JSON lines, PHP errors among them), `frontend`, `cron` (supercronic's start and result line per run, plus whatever drush printed), `mariadb`, `opensearch`. Drupal's own log is at `/admin/reports/dblog`.

The cron job reads `/app/files/.openkb-installed`, which `openkb-install` and `openkb-update` write. Without the marker it exits quietly, so the service can run before the site exists. With it, a site that does not bootstrap fails the run and supercronic logs it — a broken site is visible in `docker compose logs cron` rather than passing as a successful tick.

## Hosting the collaboration server

The Hocuspocus server is embedded in the Nitro process. Constraints for any hosted / containerized deploy:

- **Exactly 1 replica of `frontend`.** Y.Doc state is held in-process — a second replica split-brains every open document. Never scale the frontend horizontally, never enable Nitro's `node-cluster` preset (WS is unsupported there, nitro#2171), and don't set a Nitro `baseURL` on node-server (breaks WS upgrades, nitro#2347).
- **Persistent volume for the SQLite snapshot.** `frontend/var/` (or wherever `HOCUSPOCUS_SQLITE` points) is the only crash-safe copy of uncommitted edits and must live on a persistent volume — the `collab-store` volume in `docker-compose.yml`.
- **`OKB_COLLAB_CLIENT_ID` / `OKB_COLLAB_CLIENT_SECRET` on both `frontend` and `drupal`.** The collaboration server's own OAuth client: `frontend` presents it at `/oauth/token` and carries the Bearer token on every checkpoint, seed, conversation statement and client registration it relays; the PHP side provisions the consumer from the same pair (`scripts/setup-collab-oauth.sh`). They have no committed default — set them in `.env` — and without them the server has no identity: checkpoints report `no-credentials` and registration answers `temporarily_unavailable`. Holding them means being able to write as the collaboration server, so treat them as secrets.
- **Proxy idle timeouts above 60s.** Hocuspocus pings every 60s, which is borderline against a proxy that cuts idle connections at 60s — allow well above that, e.g. 300s, on the frontend host. If a CDN sits in front, check its idle timeout too (typically 90s) or bypass it for `/collaboration`.
- **Liveness probe**: `GET /api/collab/health` returns `{status, documents, connections, uptime}` from the embedded server — unauthenticated, aggregate counts only. It is the `openkb-frontend` image's healthcheck; reuse it for any hosted probe.
- **Shutdown flush**: pending debounced document stores are flushed to SQLite before the process dies. Production (`node .output/server/index.mjs`) gets this via nitro's graceful shutdown → `close` hook; dev containers wrap the server in `frontend/scripts/dev-server.sh` (see `docker-compose.development.yml`), because `nuxt dev` runs nitro in a worker thread that never sees SIGTERM.
