# Try OpenKB

An evaluation stack on your own machine: the published images, four containers,
nothing to fill in. Docker with the compose plugin is the only prerequisite.

```sh
mkdir openkb && cd openkb && curl -fsSLO "https://raw.githubusercontent.com/openkb-app/openkb/v1.0.0-alpha3/quickstart/{docker-compose.yml,.env}"
docker compose up -d
```

`up` pulls the two images (~1.3 GB), starts them next to MariaDB and OpenSearch,
and the `drupal` container installs the site on its first boot. Together that
takes a few minutes; until it is done both URLs answer with a "setting up" page
that reloads itself, and `docker compose logs -f drupal` shows the install.

Open **<http://localhost:8642>** and sign in as **`admin`** with the password
**`admin`** — the `ADMIN_PASSWORD` of `.env`. The same session opens Drupal's own
admin at <http://localhost:8643/admin>.

## The two files

| File | What it is |
|---|---|
| `docker-compose.yml` | the stack: `drupal` and `frontend` (the OpenKB images) plus `mariadb` and `opensearch`. It pulls; it never builds. |
| `.env` | every setting, filled in for localhost. Compose reads it because it sits next to the compose file. |

`frontend` runs in `drupal`'s network namespace, so `http://localhost:8642` and
`http://localhost:8643` mean the same thing in the browser and inside both
containers — the two services call each other under the same URLs you use.

**Evaluation only.** The passwords in `.env` are published with it, so they are
public, and both ports stay on `127.0.0.1`. Keep nothing in this stack you would
miss.

## What to try

- Create a space, write a page in the block editor, and open it in a second
  browser window to edit it from both.
- Invite a second user into the space and switch the space to reviewed
  publishing, so a change needs a sign-off.
- Turn on the AI chat with an OpenAI key, below, and ask it about what you
  wrote. Without a key the rest of the stack runs unchanged.

`docker compose ps` shows the four services and their health,
`docker compose logs -f drupal` — or `frontend` — the service's log.

## Running drush

Every drush command runs in the `drupal` container:

```sh
docker compose exec drupal drush status         # versions, database, bootstrap
docker compose exec drupal drush uli            # a one-time login link for admin
docker compose exec drupal drush cron           # run cron now
```

## Turning on the AI chat

The site reads the OpenAI key from the container's environment — nothing is
pasted into Drupal, and no provider has to be picked: chat and embeddings
already default to OpenAI.

```sh
OPENAI_API_KEY=sk-...       # in .env
docker compose up -d        # re-creates the containers that read it
```

Then the **Ask OpenKnowledgebase** launcher in the app's chrome opens the chat.
Pages written before the key arrives carry no embeddings yet, so re-feed the
index once:

```sh
docker compose exec drupal drush search-api:reset-tracker kb_chunks -y
docker compose exec drupal drush search-api:index kb_chunks -y
```

## Changing things

**Ports.** 8642 and 8643 are picked to collide with little. They are published
and handed to the servers unchanged, so changing one means changing the URL that
carries it too — `FRONTEND_HTTP_PORT` with `DRUPAL_FRONTEND_BASE_URL`,
`DRUPAL_HTTP_PORT` with `DRUPAL_BASE_URL`. `LISTEN_IP` moves both to another
loopback address.

**Image version.** `OPENKB_TAG` names what is pulled. These two files carry
`1.x`, the development branch, rebuilt on every push to it and built for amd64
only; the copies a release ships carry that release instead, built for amd64
and arm64. `sha-1a2b3c4` pins one build of the branch. After changing it,
`docker compose pull && docker compose up -d`. Where the new images bring
database updates, the site holds itself on a maintenance page until an
administrator has run them: sign in at <http://localhost:8643/user/login> and
open <http://localhost:8643/update.php>. The hold lifts itself when they are
through.

**OpenSearch memory mapping.** `OPENSEARCH_ALLOW_MMAP=false` is what lets this
stack start on any host: with mmap on, OpenSearch requires
`vm.max_map_count` ≥ 262144 on the host, which Linux does not grant by default.
Turning it off costs read performance on a large index — fine while evaluating,
not what a production install should run on. `OPENSEARCH_JAVA_OPTS` holds the
heap down to 256 MB for the same reason; plan 4 GB of RAM free for the stack.

## Throwing it away

```sh
docker compose down -v
```

Containers and all four volumes — database, files, collaboration snapshots and
the search index — are gone. `docker compose down -v --rmi all` drops the pulled
images with them.

Starting over is `docker compose down -v` and `up -d` again. Reinstalling in
place (`docker compose exec drupal openkb-install`) destroys the site it finds,
but the frontend's collaboration snapshots live in a volume of their own and
would carry the old site's edits into the new one — so throw the stack away
instead.

## Running it for real

A real install has two hostnames, a reverse proxy in front and secrets of its
own. It is the project's own `docker-compose.yml` with `.env.example`, described
in [`docs/self-hosting.md`](https://github.com/openkb-app/openkb/blob/1.x/docs/self-hosting.md).
