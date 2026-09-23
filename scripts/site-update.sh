#!/usr/bin/env bash
#
# Site update for openkb. Invoked by `openkb-update` and by `phapp update`.
#
#  - database updates and deploy hooks,
#  - config import, when the sync directory holds an export,
#  - cache rebuild,
#  - the install marker the cron service reads.
#
# Idempotent: a second run finds nothing to do.
set -e
cd "$(dirname "$0")/.."

DRUSH="php -d memory_limit=512M ./vendor/drush/drush/drush.php --uri=${DRUPAL_BASE_URL:-http://localhost}"

# Self-heals a site whose install stopped before the keys existed.
./scripts/ensure-oauth-keys.sh

$DRUSH updatedb -y
$DRUSH deploy:hook -y
if ls config/sync/*.yml >/dev/null 2>&1; then
  $DRUSH config:import -y
fi
$DRUSH cache:rebuild

# Reaching this point means the site bootstrapped and its updates ran, so the
# marker the cron service reads belongs there.
touch "${PERSISTENT_FILES_DIR:-files}/.openkb-installed"
