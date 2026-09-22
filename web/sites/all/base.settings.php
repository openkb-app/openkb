<?php

/**
 * @file
 * Generic project-wide settings.php file.
 *
 * Included from the site-specific settings.php with these vars set:
 *  - $env = getenv('PHAPP_ENV')
 *  - $env_type = getenv('PHAPP_ENV_TYPE')
 *  - $env_mode = getenv('PHAPP_ENV_MODE')
 */

$settings['config_sync_directory'] = '../config/sync';

// Hash salt: prefer env var, fall back to a per-site file outside the docroot.
if ($hash_salt = getenv('DRUPAL_HASH_SALT')) {
  $settings['hash_salt'] = $hash_salt;
}
elseif (file_exists(DRUPAL_ROOT . '/../hash_salt.txt')) {
  $settings['hash_salt'] = trim(file_get_contents(DRUPAL_ROOT . '/../hash_salt.txt'));
}

$settings['allow_authorize_operations'] = FALSE;

$settings['file_scan_ignore_directories'] = [
  'node_modules',
  'bower_components',
];

// Customize file directories. PERSISTENT_FILES_DIR is optional; defaults to
// the 'files' tree next to the docroot.
$settings['file_public_path'] = 'files';
$persistent_files_dir = getenv('PERSISTENT_FILES_DIR') ?: 'files';
// Anchored to DRUPAL_ROOT, so it holds whatever the working directory is.
$settings['file_private_path'] = DRUPAL_ROOT . '/../' . $persistent_files_dir . '/private';
$config['locale.settings']['translation']['path'] = '../' . $persistent_files_dir . '/public/translations';

// Make file URLs absolute, pointed at the Drupal base URL.
if ($drupal_base_url = getenv('DRUPAL_BASE_URL')) {
  $settings['file_public_base_url'] = $drupal_base_url . '/files';
}

// Auto-configure trusted-hosts-pattern from the Drupal base URL. Each env's
// own settings file can append more entries.
if ($drupal_base_url) {
  // Drop schema and port (trusted-host patterns match the host only), escape
  // dots, comma -> regex alternation.
  $trusted_host = preg_replace(['@https?://@', '@:\d+@'], '', $drupal_base_url);
  $settings['trusted_host_patterns'][] = '^' . str_replace(['.', ','], ['\.', '|'], $trusted_host) . '$';
}

$settings['container_yamls'] = [__DIR__ . '/../default/services.yml'];

// Make sure drush has the proper host when generating sitemap xml.
if (php_sapi_name() == 'cli' && $drupal_base_url) {
  $config['simple_sitemap.settings']['base_url'] = $drupal_base_url;
}

// State cache: see https://www.drupal.org/node/3177901.
$settings['state_cache'] = TRUE;

// Drupal hides modules under `tests/modules` from the extension scanner unless
// this flag is on. Three the site installs live there: `ai_test` (`echoai`, the
// no-key chat backend), `vercel_ai_sdk_mock` (the chat with no API key) and
// `openkb_search_test` (`openkb_hash`, the chunk index with no API key).
$settings['extension_discovery_scan_tests'] = TRUE;
