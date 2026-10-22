# Self-hosting

The stack ships as two images — `openkb-drupal` (Drupal on FrankenPHP, with drush; the `cron` service runs the same image with supercronic, `drush cron` every five minutes) and `openkb-frontend` (the built Nuxt server with the embedded collaboration server) — next to the official `mariadb:11.4` and `opensearchproject/opensearch:3` images. `docker-compose.yml` is that stack; every setting is an environment variable, listed in [`.env.example`](../.env.example). The `drupal` and `cron` containers get every variable of `.env` (`env_file`), so a provider key or other secret added there reaches Drupal without a compose entry; the `environment:` entries in `docker-compose.yml` set defaults and derived values on top. That includes the compose-only variables (`OPENKB_TAG`, ports, `MARIADB_ROOT_PASSWORD`): keep `.env` to what the stack's containers may see.

Both images are published to GHCR per release; [`release.md`](release.md) covers pinning a version instead of building from this checkout.

## Evaluating on a laptop

Everything below describes a real host. To just look at OpenKB, run the evaluation stack instead and skip the rest of this page: two files, no hostnames, no secrets, described in [`quickstart/README.md`](../quickstart/README.md).

## Prerequisites

- Docker with the compose plugin, 2.24 or newer (`docker compose version`).
- Two DNS names under one parent domain, both pointing at the host: one for the frontend (`kb.example.com`), one for Drupal (`admin.kb.example.com`). Drupal under a path of the frontend host is not supported.
- `vm.max_map_count=262144` on the host, for OpenSearch: `sysctl -w vm.max_map_count=262144`, and the same line in `/etc/sysctl.conf` to keep it. Keep memory mapping on for a real index; `OPENSEARCH_ALLOW_MMAP=false` drops the requirement at the cost of read performance, which is a trade for evaluation, not for production.
- A reverse proxy that terminates TLS; Caddy and Traefik examples below.

## Bring-up

```sh
cp .env.example .env              # the two URLs, the cookie domain, the secrets
docker compose build              # builds openkb-drupal and openkb-frontend from this checkout
docker compose up -d
```

The `drupal` container installs the site on its first boot: the install state the image carries, the collaboration server's OAuth client from `OKB_COLLAB_CLIENT_ID` / `OKB_COLLAB_CLIENT_SECRET`, and the `admin` password from `ADMIN_PASSWORD` — or a generated one, printed to the container log. Both services answer with a "setting up" page (`503`, `Retry-After`) until the install is through, and `docker compose logs -f drupal` carries it. A restart of an installed site reinstalls nothing; a restart after a failed install installs again. A database that holds tables but no finished OpenKB install is left alone: the setup page stays up and the log names the ways out, each followed by a restart of the `drupal` service: `openkb-update` for a working site that lacks the marker, `openkb-install`, which destroys what the database holds, or an empty database.

`docker compose exec drupal openkb-install` is the manual re-install; it destroys the site it finds.

## Updating

```sh
docker compose pull
docker compose up -d
```

Where the new images bring database updates, the site holds itself until they have been run: maintenance mode with a message naming `update.php`, cron paused, and the "setting up" page on the frontend. The Drupal host keeps serving the routes maintenance mode leaves open — `/` and `/user/login` answer 200, and `/update.php` answers an account that may run it — which is what the two steps below use. Updates are never run unattended — back up first (below), then:

1. sign in at `https://admin.kb.example.com/user/login` as an account with *Administer software updates*,
2. open `https://admin.kb.example.com/update.php` and run what it lists.

From a shell instead, `docker compose exec drupal drush updatedb` runs the same updates; back up first either way.

Both ways end in a cache rebuild, and that is what lifts the hold.

If your site imports its own `config/sync` after `updatedb`, export the config again right after `updatedb` and before the import: updates add config (such as the prompt safety guardrail sets, `docs/ai-chat.md`) that an older export would delete.

Both services listen on plain HTTP, bound to `127.0.0.1`: `drupal` on `DRUPAL_HTTP_PORT` (8080), `frontend` on `FRONTEND_HTTP_PORT` (3000). `DRUPAL_LISTEN_IP` / `FRONTEND_LISTEN_IP` open them to other hosts; then narrow `REVERSE_PROXY_ADDRESSES` to the proxy's address, or any host that reaches the port sets the client IP and the scheme Drupal sees. Keep the frontend's address in it too: the frontend relays agent registrations with the client IP, and Drupal limits them per client IP — without it, all clients share one limit. Open the frontend port to the proxy only: the frontend passes on the `X-Forwarded-For` it receives, so a client reaching it directly sets the address Drupal's login and registration floods key on.

## Outgoing mail

Drupal sends account mails — a new account's login link, password resets. The image has no mail server, so nothing leaves the site until `MAILER_DSN` names a transport:

```sh
MAILER_DSN=smtp://user:pass@smtp.example.com:587   # URL-encode the user and password
MAIL_FROM=kb@example.com                           # the sender address
```

`MAILER_DSN` switches Drupal to core's Symfony mailer with that transport; STARTTLS is used where the server offers it. Use `smtp` or `smtps`: the other [built-in transports](https://symfony.com/doc/current/mailer.html#using-built-in-transports), `sendmail` and `native`, need a local mail server the image lacks. A DSN without scheme or host is ignored, and mail stays off.

Set `MAIL_FROM` to an address the relay may send as. Unset, the sender is the installed site mail, `admin@example.com`, which relays reject.

Check it with a password reset from `https://admin.kb.example.com/user/password`; `/admin/reports/dblog` names the error when a mail fails.

Many hosts block outgoing SMTP on ports 25, 465 and 587 — netcup's default firewall policy does. Relays also listen on 2525, which passes such a firewall unchanged, e.g. Brevo:

```sh
MAILER_DSN=smtp://LOGIN%40smtp-brevo.com:SMTP_KEY@smtp-relay.brevo.com:2525
```

Brevo's SMTP login carries an `@`; it is written `%40` in the DSN.

## The reverse proxy

Whatever proxy sits in front has to:

- forward each hostname to its port, and set `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` — Drupal trusts these three, and no other forwarded header, from the addresses in `REVERSE_PROXY_ADDRESSES`;
- keep the `X-Forwarded-For` the frontend container sends and append to it, rather than replace it: the frontend relays the sign-in and password-reset forms to Drupal through the proxy, passing on the `X-Forwarded-For` it received, and Drupal's login flood keys on the client address that header carries. Drupal locks a client address after 50 failed attempts per hour, and an account after 5 failed attempts from the same address per 6 hours. A proxy that replaces the header puts every sign-in behind one address — 50 failed attempts from anyone lock the sign-in for everyone for an hour, and 5 on one account lock that account for everyone for 6 hours. Caddy and Traefik replace it unless the frontend's address is a trusted proxy (below); nginx's `$proxy_add_x_forwarded_for` appends;
- trust only the addresses the frontend and the proxy really use: a client on a trusted address can set its own `X-Forwarded-For` and rotate past the flood. The private ranges below suit a host whose only private-address clients are its containers; where clients reach the proxy from private addresses (intranet, VPN), narrow `REVERSE_PROXY_ADDRESSES` and `trusted_proxies` / `trustedIPs` to the docker network;
- upgrade WebSocket connections on `/collaboration` of the frontend host;
- allow at least 300 s idle on the frontend host: the collaboration server pings every 60 s.

Both services call each other under their public URLs, so the two names must also resolve from inside the containers — true for public DNS, and the Caddy overlay adds the in-network aliases itself.

**Caddy** (a complete configuration; Caddy sets the forwarded headers and passes WebSockets through by itself; `trusted_proxies` makes it keep the frontend's `X-Forwarded-For`):

```caddyfile
{
	servers {
		trusted_proxies static private_ranges
	}
}

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

Traefik upgrades WebSockets on its own; raise `--entrypoints.websecure.transport.respondingTimeouts.idleTimeout` to `300s`. To keep the frontend's `X-Forwarded-For`, trust the docker networks on the entrypoint: `--entrypoints.websecure.forwardedHeaders.trustedIPs=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`.

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
| `drupal-files` | `/app/files`: public and private files, the config sync directory, the OAuth keys, the `.openkb-installed` and `.openkb-installing` markers |
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
