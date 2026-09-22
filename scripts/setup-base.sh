#!/usr/bin/env bash
#
# Base setup script. Writes .env and prepares the persistent files directory.
#
# Invoked by `phapp setup <env-id>` (see phapp.yml). Expects the .env file
# to have already been written by `dotenv/print.sh` before this script runs.
set -e
cd `dirname $0`/..

# Load dotenv (sources the just-written .env).
source dotenv/loader.sh

# The collaboration server's own OAuth credentials (ADR 0001). A value anybody
# could read out of the repository is one anybody could authenticate as the
# server with, so they are generated per environment rather than committed, and
# kept in a gitignored file so re-running setup does not rotate them out from
# under a provisioned consumer. Appended to the .env `phapp setup` has just
# rewritten, which both the PHP containers and the Nuxt server read.
if [[ -z "$OKB_COLLAB_CLIENT_ID" || -z "$OKB_COLLAB_CLIENT_SECRET" ]]; then
  if [[ ! -s .collab-oauth ]]; then
    printf 'OKB_COLLAB_CLIENT_ID=%s\nOKB_COLLAB_CLIENT_SECRET=%s\n' \
      "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
      "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > .collab-oauth
    chmod 600 .collab-oauth
  fi
  cat .collab-oauth >> .env
fi

# The download caches docker-compose.development.yml mounts. Created here so
# they belong to the host user, not to docker.
mkdir -p .cache/.composer/cache .cache/.npm

mkdir -p $PERSISTENT_FILES_DIR/public
mkdir -p $PERSISTENT_FILES_DIR/public/translations
mkdir -p $PERSISTENT_FILES_DIR/private

if [ -n "$ENV_UNIX_GROUP_WEBSERVER" ]; then
  if [[ $(id -u) -eq 0 || $(command -v sudo) ]]; then
      # The group may not exist on the host OS (e.g. MacOS); ignore the error.
      sudo chown -R :$ENV_UNIX_GROUP_WEBSERVER \
        $PERSISTENT_FILES_DIR/public \
        $PERSISTENT_FILES_DIR/private 2>/dev/null || true
      # Propagate the webserver group via setgid on subdirectories.
      sudo chmod 2775 $PERSISTENT_FILES_DIR/public 2>/dev/null || true
      sudo chmod 2775 $PERSISTENT_FILES_DIR/public/translations 2>/dev/null || true
      sudo chmod 2775 $PERSISTENT_FILES_DIR/private 2>/dev/null || true
    fi
fi

# Migrate files for legacy dev installs.
if [[ -d web/files ]] && [[ ! -L web/files ]]; then
  mv web/files/* $PERSISTENT_FILES_DIR/public 2>/dev/null || true
  rm -rf web/files
fi

# Symlink web/files -> ../$PERSISTENT_FILES_DIR/public.
if [[ ! -L web/files ]]; then
  ln -sfn ../$PERSISTENT_FILES_DIR/public web/files
fi
