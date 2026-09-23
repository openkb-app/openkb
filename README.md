# OpenKB

**The open knowledge base for people and AI agents.** Markdown pages, collaboratively edited, reviewed before they publish, and readable by people and by agents through the same store.

Website, product overview and documentation: **[openkb.app](https://openkb.app)**.

## Try it in five minutes

Two files into an empty directory, and the published images do the rest. Docker with the compose plugin is the only prerequisite.

```sh
mkdir openkb && cd openkb && curl -fsSLO "https://raw.githubusercontent.com/openkb-app/openkb/v1.0.0-alpha1/quickstart/{docker-compose.yml,.env}"
docker compose up -d
```

The `drupal` container installs the site on its first boot — a few minutes, with a "setting up" page until it is through. Then open <http://localhost:8642> and sign in as `admin` / `admin`. `docker compose down -v` throws the stack away. [`quickstart/README.md`](quickstart/README.md) has the walk-through: what to try, the ports, the image tag, and why an evaluation stack runs OpenSearch without memory mapping. It is for evaluation only. A real install is [Installation](#installation) below.

## What you get

- **Pages in Markdown**, organised in spaces, with a block-level editor that several people and agents edit at the same time.
- **Review before publish**: every change carries who made it and who signed it off. Spaces choose whether human and agent edits need a reviewer.
- **AI chat with citations**: answers come from your pages and link to the block they came from. An answer without a source says so.
- **Agents as first-class users**: an [MCP](https://modelcontextprotocol.io) endpoint with search, read and write tools. An agent acts through an OAuth client with its own, narrower permissions, never more than the person who granted them.
- **Search that understands the question**: hybrid keyword + semantic search over the whole base, filtered by space, type, tags and freshness, respecting every reader's access. The chat and the agents use the same search.
- **Vendor-agnostic AI**: built on the [Drupal AI](https://www.drupal.org/project/ai) framework. Chat and embeddings run on the provider you choose and can be switched without touching the product.
- **Self-hostable**: one compose stack of five services, `drupal`, `cron` and `frontend` (our two images) plus MariaDB and OpenSearch, behind your reverse proxy.

## Requirements

**Host, for the container stack:**

| | Evaluation (`quickstart/`) | Production ([`docs/self-hosting.md`](docs/self-hosting.md)) |
|---|---|---|
| Containers | any OCI runtime with Compose-compatible tooling; Docker Engine with the Compose v2 plugin is what we test, other engines such as Podman may work; amd64 or arm64 | same |
| CPU | 2 cores | 4 cores, more for many concurrent readers |
| RAM | 4 GB free for the stack | 8 GB free, with an OpenSearch heap of 1 GB or more (`OPENSEARCH_JAVA_OPTS`) |
| Disk | 5 GB: the four images are ~4.6 GB (OpenSearch 2.8 GB, `openkb-drupal` 1.0 GB, MariaDB 0.5 GB, `openkb-frontend` 0.3 GB) | 20 GB plus what your pages, files and database grow to |
| Kernel | none | Linux with `vm.max_map_count=262144` for OpenSearch |
| Network | localhost | two hostnames under one domain, a reverse proxy that terminates TLS |

**Browsers**: current Chrome, Edge, Firefox and Safari. The frontend is built with Tailwind CSS 4, whose floor is Safari 16.4, Chrome 111 and Firefox 128 ([compatibility](https://tailwindcss.com/docs/compatibility)).

**AI features**: an API key of a supported provider, OpenAI by default; see [AI setup](#ai-setup). Everything else runs without one.

## Installation

The container stack is how OpenKB is run. The quickstart above is the evaluation flavour: published passwords, ports on loopback, nothing to configure. A real deployment is the project's own [`docker-compose.yml`](docker-compose.yml) with a `.env` of your own:

```sh
git clone https://github.com/openkb-app/openkb.git && cd openkb
cp .env.example .env              # the two URLs, the cookie domain, the secrets; OPENKB_TAG=<release> pulls instead of building
docker compose pull && docker compose up -d
```

The rest is as in [Try it in five minutes](#try-it-in-five-minutes). [`docs/self-hosting.md`](docs/self-hosting.md) covers what a real host needs:

- the two hostnames: `kb.example.com` for the frontend, `admin.kb.example.com` for Drupal;
- the reverse-proxy contract, with Caddy, Traefik, nginx and Cloudflare Tunnel examples;
- the secrets in [`.env.example`](.env.example), each an `openssl rand -hex 32`;
- the collaboration server: exactly one `frontend` replica;
- the backup set: database, `drupal-files` volume and `collab-store` volume, backed up and restored together.

[`docs/release.md`](docs/release.md) describes the image tags `OPENKB_TAG` can name.

**Outside containers.** Running the backend and the frontend on your own hosting is advanced. It is for people who run Drupal and Nuxt themselves; the images are what the release tests run.

- Backend: a Composer-managed Drupal 11 project ([`composer.json`](composer.json), [`web/`](web/), the `drupal/openkb` module from [drupal.org](https://www.drupal.org/project/openkb)). PHP 8.3, MariaDB, an OpenSearch 3 cluster. [`scripts/site-install.sh`](scripts/site-install.sh) installs, [`scripts/site-update.sh`](scripts/site-update.sh) updates. See [Drupal's requirements](https://www.drupal.org/docs/getting-started/system-requirements).
- Frontend: a Nuxt 4 application ([`frontend/`](frontend/)), `npm run build`, one long-lived Node 22 process with a persistent `frontend/var/`. See the [Nuxt](https://nuxt.com/docs/getting-started/deployment) and [Nitro](https://nitro.build/deploy) deployment guides and the constraints in [`docs/self-hosting.md`](docs/self-hosting.md#hosting-the-collaboration-server).
- The two halves talk as any [Lupus Decoupled](https://lupus-decoupled.org/get-started/how-it-works) site does.

## AI setup

**Providers.** OpenKB uses the [Drupal AI](https://www.drupal.org/project/ai) framework. The site-wide defaults at `/admin/config/ai/settings` name the chat provider and the embeddings provider; every AI operation follows them.

| Provider | In the image | To use it |
|---|---|---|
| [OpenAI](https://www.drupal.org/project/ai_provider_openai) | enabled, the default for chat and embeddings (`text-embedding-3-small`) | set `OPENAI_API_KEY` in `.env`, nothing to configure |
| [amazee.ai](https://www.drupal.org/project/ai_provider_amazeeio) | enabled | paste the key at `/admin/config/system/keys`, pick it at `/admin/config/ai/providers/amazeeio`, then select the provider in the defaults |

Any provider of the Drupal AI framework can be added; the [provider list](https://www.drupal.org/project/ai) has them. Docs for more providers follow.

**The key.** With OpenAI, the key is read from the container's environment and never stored in the site:

```sh
OPENAI_API_KEY=sk-...             # in .env
docker compose up -d              # re-creates the containers that read it
```

`/admin/config/ai/explorers` has a test form per operation to prove the key answers.

**What it enables.** The **Ask OpenKnowledgebase** chat, grounded in your pages with citations, and the semantic half of search: each published block is embedded into the `kb_chunks` index and retrieved by meaning as well as by its words. Without a key, keyword search, editing, review and agents work unchanged; the chat reports that no provider answers.

**After adding the key**, pages written before it carry no embeddings yet. Re-feed the index once:

```sh
docker compose exec drupal drush search-api:reset-tracker kb_chunks -y
docker compose exec drupal drush search-api:index kb_chunks -y
```

**Changing the embeddings provider or model** invalidates every stored vector: vectors are only comparable within one model. The engine is named on the search server at `/admin/config/search/search-api/server/ai_chunks`. After changing it, delete the collection and index again:

```sh
docker compose exec drupal curl -sf -X DELETE http://opensearch:9200/default_kb_chunks
docker compose exec drupal drush search-api:reset-tracker kb_chunks -y
docker compose exec drupal drush search-api:index kb_chunks -y
```

**Cost and privacy.** The provider receives the text of every published block once per index run, and, per question, the question with the passages retrieved for it. Its pricing and data-use terms apply to that traffic. Nothing else leaves the stack.

## Updates

1. **Back up** the database and the `drupal-files` and `collab-store` volumes. The commands are in [`docs/self-hosting.md`](docs/self-hosting.md#volumes-and-backup).
2. Set the new version in `.env`, `OPENKB_TAG=1.0.1`, then pull and restart the images:

   ```sh
   docker compose pull && docker compose up -d
   ```

3. **Run the database updates.** Where the new images bring database updates, the site holds itself until an administrator has run them: maintenance mode with a message naming `update.php`, cron paused. Sign in at `https://admin.kb.example.com/user/login` with an account that may *administer software updates* (`admin`), open `https://admin.kb.example.com/update.php` and run what it lists. The hold lifts itself. Nothing is updated unattended.

   From a shell, `docker compose exec drupal drush updatedb` runs the same updates and lifts the hold the same way.

Every release carries its notes on the [releases page](https://github.com/openkb-app/openkb/releases) and in [`CHANGELOG.md`](https://github.com/openkb-app/openkb/blob/1.x/CHANGELOG.md). The module inside the image is released as the same version on [drupal.org/project/openkb](https://www.drupal.org/project/openkb). Pin an exact version in `OPENKB_TAG`; [`docs/release.md`](docs/release.md) lists the other tags and what they follow.

## How it is built

A Drupal 11 backend: content, permissions, review workflow, JSON:API and MCP, in the [`drupal/openkb`](https://www.drupal.org/project/openkb) module. A Nuxt 4 frontend with Nuxt UI, TipTap and Y.js ([`frontend/`](frontend/)), with the Hocuspocus collaboration server embedded in the same process. Search is OpenSearch 3 through [Search API](https://www.drupal.org/project/search_api); the database is MariaDB 11.4. The two own images build from [`docker/`](docker/). [`docker-compose.development.yml`](docker-compose.development.yml) runs them with this checkout mounted, a `cli` container for composer and drush, and the Nuxt dev server with hot reload.

## Issues and contributions

- **Backend** (the Drupal module, API, permissions, workflow, MCP): the issue queue of [drupal.org/project/openkb](https://www.drupal.org/project/openkb), also where the module's releases and security coverage live.
- **Frontend, images, self-hosting and everything else**: [GitHub issues](https://github.com/openkb-app/openkb/issues) in this repository.

Not sure where a bug belongs? File it here; it gets moved and linked if the fix is in the module.

Security reports: see [`SECURITY.md`](SECURITY.md).

### AI-generated code

Most of OpenKB is written with AI coding tools, in a workflow where every change is drafted by an agent from a written plan, then read, tested and approved by a human before it is submitted. Contributions to this repository and to the module on drupal.org are held to the same rule: disclose what an AI generated, and stand behind it as your own.

## Credits

- [drunomics GmbH](https://www.drupal.org/drunomics) <hello@drunomics.com>: concept, development, maintenance.

## License

The backend, the `drupal/openkb` module and everything outside `frontend/`, is [GPL-2.0-or-later](LICENSE); the frontend (`frontend/`) is [MIT](frontend/LICENSE).
