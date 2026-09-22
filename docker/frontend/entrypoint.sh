#!/bin/sh
# Maps the stack's two URLs onto the Nuxt runtime config. A NUXT_* variable set
# directly wins.
set -e

export NUXT_PUBLIC_DRUPAL_CE_DRUPAL_BASE_URL="${NUXT_PUBLIC_DRUPAL_CE_DRUPAL_BASE_URL:-$DRUPAL_BASE_URL}"
# Separate keys from nuxtjs-drupal-ce's: the server's own Drupal fetches, and
# the links the browser gets.
export NUXT_DRUPAL_BASE_URL="${NUXT_DRUPAL_BASE_URL:-$DRUPAL_BASE_URL}"
export NUXT_PUBLIC_DRUPAL_BASE_URL="${NUXT_PUBLIC_DRUPAL_BASE_URL:-$DRUPAL_BASE_URL}"

exec "$@"
