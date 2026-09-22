# OpenKB

**The open knowledge base for people and AI agents.** Markdown pages, collaboratively edited, reviewed before they publish, and readable by people and by agents through the same store.

Website, product overview and documentation: **[openkb.app](https://openkb.app)**.

## What you get

- **Pages in Markdown**, organised in spaces, with a block-level editor that several people and agents edit at the same time.
- **Review before publish**: every change carries who made it and who signed it off; spaces choose whether human and agent edits need a reviewer.
- **AI chat with citations**: answers come from your pages and link to the block they came from; an answer without a source says so.
- **Agents as first-class users**: an [MCP](https://modelcontextprotocol.io) endpoint with search, read and write tools, scoped by OAuth clients and the same permissions people have.
- **Search** over pages and chunks (OpenSearch, hybrid lexical + vector), with type, tag, space and freshness filters.
- **Self-hostable**: one compose stack of four services — `drupal` and `frontend` (our two images) plus MariaDB and OpenSearch — behind your reverse proxy.

## How it is built

| Part | Technology | Where | License |
|---|---|---|---|
| Backend | Drupal 11 on FrankenPHP: content, permissions, review workflow, JSON:API, MCP | [`openkb/`](openkb/) (the `drupal/openkb` module and its companions) | GPL-2.0-or-later |
| Frontend | Nuxt 4, Nuxt UI, TipTap, Y.js with an embedded Hocuspocus collaboration server | [`frontend/`](frontend/) | MIT |
| Search | OpenSearch 3 through Search API | `opensearchproject/opensearch` image | Apache-2.0 |
| Database | MariaDB 11.4 | `mariadb` image | GPL-2.0 |
| Stack | `drupal` (`openkb-drupal`), `frontend` (`openkb-frontend`), `mariadb`, `opensearch`; the two own images build from [`docker/`](docker/) | [`docker-compose.yml`](docker-compose.yml) | |

The backend and the frontend talk over JSON:API and custom elements; agents talk to the backend over MCP. [`docs/architecture.md`](docs/architecture.md) has the topology, the trust boundaries and the search and chunk indexes; the decisions behind the design are in [`docs/adr/`](docs/adr/).

## Run it

Prerequisites: Docker with the compose plugin, two hostnames under one parent domain (one for the frontend, one for Drupal), a reverse proxy that terminates TLS (a Caddy overlay is bundled), and `vm.max_map_count=262144` on the host for OpenSearch.

```sh
git clone https://github.com/openkb-app/openkb.git && cd openkb
cp .env.example .env              # the two URLs, the cookie domain, the secrets
docker compose build              # builds openkb-drupal and openkb-frontend
docker compose up -d
docker compose exec drupal openkb-install
```

`openkb-install` installs the site from the OpenKB recipes named in `OPENKB_RECIPES_DIR`, provisions the collaboration server's OAuth client and prints the admin password when `ADMIN_PASSWORD` is unset. Updating is `docker compose pull && docker compose up -d && docker compose exec drupal openkb-update`.

Every setting is an environment variable, listed with its meaning in [`.env.example`](.env.example). The reverse-proxy contract (headers, the WebSocket on `/collaboration`, idle timeouts), the bundled Caddy overlay, the backup set and the collaboration server's constraints are in [`docs/self-hosting.md`](docs/self-hosting.md).

## Develop

`docker-compose.development.yml` runs the same images with this checkout mounted, a `cli` container for composer, drush and phpunit, and the Nuxt dev server with hot reload; `docker-compose.localdev.yml` binds the ports for a workstation. The frontend's own commands are in [`frontend/package.json`](frontend/package.json); the backend's checks are `composer cs` and `composer phpstan-check`.

## Issues and contributions

- **Backend** (the Drupal module, API, permissions, workflow, MCP): the issue queue of [drupal.org/project/openkb](https://www.drupal.org/project/openkb) — also where the module's releases and security coverage live.
- **Frontend, images, self-hosting and everything else**: [GitHub issues](https://github.com/openkb-app/openkb/issues) in this repository.

Not sure where a bug belongs? File it here; it gets moved and linked if the fix is in the module.

Security reports: see [`SECURITY.md`](SECURITY.md).

## License

The backend (`openkb/`, `web/modules/`) is [GPL-2.0-or-later](LICENSE); the frontend (`frontend/`) is [MIT](frontend/LICENSE). OpenKB is developed by [drunomics](https://drunomics.com).
