<?php

/**
 * @file
 * Per-site settings.php file.
 *
 * Sources the layered settings hierarchy under ../all/ based on the
 * PHAPP_ENV / PHAPP_ENV_TYPE / PHAPP_ENV_MODE environment vars.
 */

$env = getenv('PHAPP_ENV');
$env_type = getenv('PHAPP_ENV_TYPE') ?: 'docker';
$env_mode = getenv('PHAPP_ENV_MODE') ?: 'production';

// Site-specific prefix variable usable during configuration.
$site = basename(realpath(__DIR__));

// Shared base settings.
require __DIR__ . '/../all/base.settings.php';

// Per env-type (e.g. docker) settings, if present.
if ($env_type && file_exists(__DIR__ . '/../all/base-' . $env_type . '.settings.php')) {
  require __DIR__ . '/../all/base-' . $env_type . '.settings.php';
}
// Per env (localdev, claude-vm, dev, stage, live) settings, if present.
if ($env && file_exists(__DIR__ . '/../all/env.' . $env . '.settings.php')) {
  require __DIR__ . '/../all/env.' . $env . '.settings.php';
}
// Per env-mode (development or production) overrides, if present.
if ($env_mode && file_exists(__DIR__ . '/../all/' . $env_mode . '.settings.php')) {
  require __DIR__ . '/../all/' . $env_mode . '.settings.php';
}

// Load local override settings if present (gitignored).
if (file_exists(__DIR__ . '/settings.local.php')) {
  include __DIR__ . '/settings.local.php';
}
