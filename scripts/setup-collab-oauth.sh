#!/usr/bin/env bash
#
# Provision the collaboration server's OAuth client from the environment.
#
# The scope and the role it is capped at ship in openkb_recipe_collab; this
# script creates the consumer and its service user, which cannot live in
# config because the credentials are per environment. Idempotent: a re-run
# brings the consumer to what the environment says, so a rotated secret takes
# effect on the next deploy (drush okb:create-oauth-consumer). The secret is
# passed by variable name, not by value — argv is world-readable.
#
# Without credentials it does nothing and says so — the collab server then has
# no identity, and every checkpoint it makes is refused by Drupal.
set -e
cd `dirname $0`/..

if [ -z "${OKB_COLLAB_CLIENT_ID:-}" ] || [ -z "${OKB_COLLAB_CLIENT_SECRET:-}" ]; then
  echo "OKB_COLLAB_CLIENT_ID / OKB_COLLAB_CLIENT_SECRET are unset — no collaboration client provisioned." >&2
  exit 0
fi

php ./vendor/drush/drush/drush.php --uri="${DRUPAL_BASE_URL:-http://localhost}" \
  okb:create-oauth-consumer 'Collaboration server' \
  --client-id="$OKB_COLLAB_CLIENT_ID" \
  --secret-env=OKB_COLLAB_CLIENT_SECRET \
  --user=collab_server \
  --role=collab_server \
  --scopes=collab
