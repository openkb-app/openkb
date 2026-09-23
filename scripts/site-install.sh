#!/usr/bin/env bash
#
# Site install for openkb. Invoked by `openkb-install` and by `phapp init`.
#
# Runs where Drupal's code is: the `drupal` container, or `cli` in development.
#  - clear the stale config sync dir (a fresh drush si does not populate it
#    and stale exports cause cim/UI validation to fail later),
#  - wait for OpenSearch (search_api_opensearch pings during recipe import;
#    the cluster needs ~10-30s to start),
#  - drush site-install with one recipe: install-state, the applied result of
#    the source recipes the public image ships; or the one the environment
#    names in OPENKB_ENV_RECIPE (openkb_recipe_dev in development,
#    openkb_recipe_ci on CI), or openkb_recipe_main — the app itself — where
#    it names none. Each carries the whole site, so nothing is applied on top,
#  - wire the frontend URL: the comark search processor resolves the Nuxt
#    sidecar from it at index time,
#  - install-content where the image ships it: the entities every site starts
#    with,
#  - provision the collab server's OAuth client,
#  - enable services_env_parameter, set the admin and test-editor passwords,
#  - wait for the sidecar, then re-feed the search indexes (automated cron is
#    held off from the install until this is done, so it cannot hold the
#    index lock),
#
# The recipes are read from OPENKB_RECIPES_DIR (default: recipes/), next to the
# composer-installed lupus_decoupled_recipe they build on.
#
# The collab snapshot store is left alone here — it belongs to `frontend`, which
# this container cannot cycle. Reset it from the host with
# scripts/reset-collab-store.sh.
set -e
cd `dirname $0`/..

DRUSH="php -d memory_limit=512M ./vendor/drush/drush/drush.php --uri=${DRUPAL_BASE_URL:-http://localhost}"
FRONTEND_URL=${DRUPAL_FRONTEND_BASE_URL:?DRUPAL_FRONTEND_BASE_URL must name the frontend URL}

RECIPES_DIR=${OPENKB_RECIPES_DIR:-recipes}
[ ! -d "$RECIPES_DIR" ] || RECIPES_DIR=$(cd "$RECIPES_DIR" && pwd)
# The public image ships the applied result of the source recipes as
# install-state and install-content; a checkout ships the source set.
if [ -f "$RECIPES_DIR/install-state/recipe.yml" ]; then
  RECIPE=${RECIPE:-$RECIPES_DIR/install-state}
  CONTENT_RECIPE=$RECIPES_DIR/install-content
elif [ -f "$RECIPES_DIR/openkb_recipe_main/recipe.yml" ]; then
  RECIPE=${RECIPE:-$RECIPES_DIR/${OPENKB_ENV_RECIPE:-openkb_recipe_main}}
  CONTENT_RECIPE=
else
  echo "No OpenKB recipes in $RECIPES_DIR. Mount them and name the directory in OPENKB_RECIPES_DIR." >&2
  exit 1
fi

# 0. Ensure the simple_oauth keypair before anything can fail: a partial
# install (e.g. a recipe apply aborting) must never leave the env without
# OAuth keys. Idempotent — existing keys survive redeploys.
./scripts/ensure-oauth-keys.sh

# 1. Wipe the config sync directory.
echo "Clearing stale config sync dir..."
find config/sync/ -mindepth 1 ! -name .gitkeep ! -name .htaccess -delete 2>/dev/null || true

# 2. Wait for OpenSearch to accept requests.
OPENSEARCH_URL=${OPENSEARCH_URL:-http://opensearch:9200}
echo "Waiting for OpenSearch at $OPENSEARCH_URL..."
for i in $(seq 1 60); do
  if curl -sf "$OPENSEARCH_URL/_cluster/health" >/dev/null 2>&1; then
    echo "  OpenSearch ready (after ${i}s)"
    break
  fi
  [ $i -eq 60 ] && { echo "  OpenSearch did not become ready in 60s" >&2; exit 1; }
  sleep 1
done

# 2b. The OpenSearch data volume outlives a site reinstall, and
# `default_kb_chunks` keeps rows keyed by entity ids the reinstalled site
# lacks; the chat cites them.
echo "Dropping the stale chunk collection..."
curl -sf -X DELETE "$OPENSEARCH_URL/default_kb_chunks" >/dev/null 2>&1 || true

# 3. Site install. One recipe carries the whole site: openkb_recipe_main is
# the app, and the environment recipes (openkb_recipe_dev, openkb_recipe_ci)
# carry it plus what they add. RECIPE overrides both, for installing a part of
# the app on its own.
echo "Installing Drupal..."
# Read-only, so the installer leaves the env-driven settings.php alone.
chmod a-w web/sites/default/settings.php 2>/dev/null || true
$DRUSH sql-create -y
echo "  recipe: $RECIPE"
$DRUSH si -y --site-name='OpenKB' "$RECIPE"

# The installer swaps every cache backend for an in-memory one, so nothing the
# install writes reaches the DB-backed caches. Web traffic (frontend schema fetches,
# health checks) racing it reads config that does not exist yet, and CachedStorage
# keeps serving that miss. This drops what the install window cached.
$DRUSH cache:rebuild

# A fresh site has no last cron run, so the first web request runs cron — and
# cron indexes kb_chunks, holding the index lock against the re-index in
# step 6. Off until the index is fed; the index does not exist yet here.
CRON_INTERVAL=$($DRUSH config:get automated_cron.settings interval --format=string)
$DRUSH config:set automated_cron.settings interval 0 -y

# 4. Wire the frontend URL. The comark search processor reads the Nuxt
# sidecar's origin from this setting, so the seed content the install imported
# is indexed without its body until step 6 re-feeds the index.
echo "Configuring frontend URL..."
$DRUSH config:set lupus_decoupled_ce_api.settings frontend_base_url "$FRONTEND_URL" -y
$DRUSH config:set lupus_decoupled_ce_api.settings preview_provider "nuxt" -y

# 5. The content every site starts with, where the image ships it as a recipe
# of its own. After the frontend URL, which the import reads.
if [ -n "$CONTENT_RECIPE" ] && [ -f "$CONTENT_RECIPE/recipe.yml" ]; then
  echo "Applying $CONTENT_RECIPE..."
  $DRUSH recipe "$CONTENT_RECIPE" -y
fi

# 5a. The collaboration server's own OAuth client. After the install, which
# ships the scope and the role it is capped at.
./scripts/setup-collab-oauth.sh

echo "Enabling services_env_parameter..."
$DRUSH en services_env_parameter -y

echo "Setting admin password..."
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
  echo "  ADMIN_PASSWORD is unset. Generated password for admin: $ADMIN_PASSWORD"
fi
$DRUSH user:password admin "$ADMIN_PASSWORD"

# 5b. Passwords for the seeded test editors. Only where an environment recipe
# brought them: production installs no demo content and has no such accounts.
#
# The accounts themselves come from openkb_recipe_demo_pages' content, which
# cannot carry a password — content YAML would hold a hash. They are the manual-
# testing accounts: `admin` answers every access question with "yes", so a
# space roster, a moderated space or a non-member's 404 can only be exercised
# as someone else. `TEST_USER_PASSWORD` defaults to the shared dev secret every
# development stack already has in `dotenv/app.env`.
case "$RECIPE" in
  *openkb_recipe_dev*|*openkb_recipe_ci*)
    TEST_USER_PASSWORD=${TEST_USER_PASSWORD:-${APP_SECRET:-lupus123}}
    for account in editor1 editor2; do
      echo "Setting $account password..."
      $DRUSH user:password "$account" "$TEST_USER_PASSWORD"
    done
    ;;
esac

# 6. Re-feed the search index once the sidecar can actually enrich items.
#
# A page that is indexed while the Nuxt sidecar is still starting lands
# without its chunks — the sidecar is what cuts them — and search_api records
# it as indexed, so a plain `search-api:index` afterwards reports "up to date"
# and repairs nothing. Wait for the sidecar, then reset the tracker so every
# item is queued again and re-enriched.
if $DRUSH search-api:list 2>/dev/null | grep -q kb_chunks; then
  echo "Waiting for the Nuxt sidecar at $FRONTEND_URL..."
  for i in $(seq 1 120); do
    if curl -sf -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' \
        -d '{"markdown":"# ping"}' "$FRONTEND_URL/api/comark/indexable"; then
      echo "  sidecar ready (after ${i}s)"
      break
    fi
    # Indexing without it produces a site whose pages hold no searchable text.
    [ $i -eq 120 ] && {
      echo "  POST $FRONTEND_URL/api/comark/indexable did not answer in 120s." >&2
      echo "  The page bodies cannot be indexed. Check that the frontend is" >&2
      echo "  running and that DRUPAL_FRONTEND_BASE_URL (which becomes" >&2
      echo "  lupus_decoupled_ce_api.settings frontend_base_url) is reachable" >&2
      echo "  from this container." >&2
      exit 1
    }
    sleep 1
  done

  # The fixture holds the vectors of the seed content only, so it is loaded on
  # the environments that install that content — as with the test editors
  # above. A keyed environment then indexes the seed pages without
  # paying for them again; a text the fixture does not hold reaches the engine.
  case "$RECIPE" in
    *openkb_recipe_dev*|*openkb_recipe_ci*)
      echo "Loading the embedding fixture..."
      $DRUSH openkb:embeddings-import
      ;;
  esac

  echo "Embedding seed content into the chunk index..."
  $DRUSH search-api:reset-tracker kb_chunks -y
  $DRUSH search-api:index kb_chunks -y
fi

# Automated cron back on. The index is fed, so its next run has nothing to do.
$DRUSH config:set automated_cron.settings interval "$CRON_INTERVAL" -y

# 7. Rebuild caches. A recipe installs its modules with config sync active, and
# simple_oauth's access policy answers a permission calculation made in that
# window with an empty set. The processor stores it in the persistent
# access-policy cache and nothing invalidates the `access_policies` tag, so
# anonymous keeps no `access content` — and /openkb/schema, which the frontend
# fetches anonymously, answers 403.
echo "Rebuilding caches..."
$DRUSH cache:rebuild

echo ""
echo "Site installation complete."
# The collab snapshot store belongs to the frontend and outlives this install,
# so a reinstall needs it dropped; how depends on the tree.
if [ -x scripts/reset-collab-store.sh ]; then
  echo "Reinstall: drop the collab snapshot store from the host with ./scripts/reset-collab-store.sh"
else
  echo "Reinstall over a running stack: the collab snapshot store still holds the old site's edits — 'docker compose down -v', then install again."
fi
echo ""
echo "  Site:  $FRONTEND_URL"
echo "  Admin: ${DRUPAL_BASE_URL:-}/admin"
echo "  Sign in as 'admin', with the ADMIN_PASSWORD from .env."
