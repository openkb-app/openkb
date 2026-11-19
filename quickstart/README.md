# Try OpenKB

An evaluation stack on your own machine: the newest release's images, four
containers, nothing to fill in. Docker with the compose plugin (2.24 or newer) is the only prerequisite.

```sh
mkdir openkb && cd openkb
curl -fsSLO https://github.com/openkb-app/openkb/releases/latest/download/docker-compose.yml
docker compose up -d
```

`up` pulls the two images (~1.3 GB), starts them next to MariaDB and OpenSearch,
and the `drupal` container installs the site on its first boot. Together that
takes a few minutes; until it is done both URLs answer with a "setting up" page
that reloads itself, and `docker compose logs -f drupal` shows the install.

Open **<http://localhost:8642>** and sign in as **`admin`** with the password
**`admin`** — the default `ADMIN_PASSWORD`. The same session opens Drupal's own
admin at <http://localhost:8643/admin>.

## The one file

`docker-compose.yml` is the stack: `drupal` and `frontend` (the OpenKB images)
plus `mariadb` and `opensearch`. It pulls; it never builds. Every setting has
its value in it, filled in for localhost.

A `.env` next to it is optional. Compose reads it when it is there: a line in it
overrides the value in `docker-compose.yml`, and every line reaches the `drupal`
and `cron` containers. Create it with only the lines you change; the sections
below name them.

`frontend` runs in `drupal`'s network namespace, so `http://localhost:8642` and
`http://localhost:8643` mean the same thing in the browser and inside both
containers — the two services call each other under the same URLs you use.

**Evaluation only.** The passwords in `docker-compose.yml` are published with
it, so they are public, and both ports stay on `127.0.0.1`. Keep nothing in this
stack you would miss.

## What to try

- Create a space, write a page in the block editor, and open it in a second
  browser window to edit it from both.
- Invite a second user into the space and switch the space to reviewed
  publishing, so a change needs a sign-off.
- Turn on the AI assistant with an OpenAI key, below, and ask it about what you
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

## Turning on the AI assistant

The site reads the OpenAI key from the container's environment — nothing is
pasted into Drupal, and no provider has to be picked: chat and embeddings
already default to OpenAI.

```sh
echo 'OPENAI_API_KEY=sk-...' >> .env   # creates .env when there is none
docker compose up -d                   # re-creates the containers that read it
```

Then the **Ask OpenKnowledgebase** launcher in the app's chrome opens the chat.
Pages written before the key arrives carry no embeddings yet, so re-feed the
index once:

```sh
docker compose exec drupal drush search-api:reset-tracker kb_chunks -y
docker compose exec drupal drush search-api:index kb_chunks -y
```

## Changing things

Each setting below is a line in `.env`, e.g. `OPENKB_TAG=1.2.3`, followed by
`docker compose up -d`.

**Ports.** 8642 and 8643 are picked to collide with little. They are published
and handed to the servers unchanged, so changing one means changing the URL that
carries it too — `FRONTEND_HTTP_PORT` with `DRUPAL_FRONTEND_BASE_URL`,
`DRUPAL_HTTP_PORT` with `DRUPAL_BASE_URL`. `LISTEN_IP` moves both to another
loopback address.

**Image version.** `OPENKB_TAG` names what is pulled:

- `latest`, the default: the newest release, for amd64 and arm64.
- `1.2.3`: that release, pinned.
- `1.x`: the development branch, rebuilt on every push to it, amd64 only.
- `sha-1a2b3c4`: one build of the branch, pinned.

Updating is one command, `docker compose pull && docker compose up -d`: it
fetches what `OPENKB_TAG` names now. Run the `curl` line above before it
to also move MariaDB and OpenSearch to the versions the newest release was
tested with. Database updates run at <http://localhost:8643/update.php>, as
[`docs/self-hosting.md`](https://github.com/openkb-app/openkb/blob/1.x/docs/self-hosting.md#updating)
describes.

**OpenSearch memory mapping.** `OPENSEARCH_ALLOW_MMAP=false`, the default here,
is what lets this stack start on any host: with mmap on, OpenSearch requires
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
