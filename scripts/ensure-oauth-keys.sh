#!/usr/bin/env bash
#
# Ensure the simple_oauth RSA keypair exists in the persistent private dir.
#
# Idempotent: existing keys are never touched, so redeploys keep issued
# tokens valid. Drupal-free: uses plain openssl instead of
# `drush simple-oauth:generate-keys`, so it works before Drupal is
# installed and cannot be skipped by a failure later in the install.
# Key parameters mirror simple_oauth's KeyGenerator (RSA 4096,
# private.key/public.key, mode 600); simple_oauth.settings points at
# private://simple_oauth/*.key (see recipes/openkb_recipe_main/recipe.yml).
set -e
cd `dirname $0`/..

# The private files dir, resolved as web/sites/all/base.settings.php does.
PERSISTENT_FILES_DIR=${PERSISTENT_FILES_DIR:-files}

KEYS_DIR="$PERSISTENT_FILES_DIR/private/simple_oauth"

if [ -f "$KEYS_DIR/private.key" ] && [ -f "$KEYS_DIR/public.key" ]; then
  echo "simple_oauth keys present in $KEYS_DIR — leaving untouched."
  exit 0
fi

echo "Generating simple_oauth keys in $KEYS_DIR..."
mkdir -p "$KEYS_DIR"
openssl genpkey -quiet -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  -out "$KEYS_DIR/private.key"
openssl rsa -in "$KEYS_DIR/private.key" -pubout -out "$KEYS_DIR/public.key" 2>/dev/null
chmod 600 "$KEYS_DIR/private.key" "$KEYS_DIR/public.key"
echo "simple_oauth keys generated."
