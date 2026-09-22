<?php

/**
 * @file
 * Settings overrides for production environments.
 *
 * Active when PHAPP_ENV_MODE=production.
 */

// Don't show any error messages on the site (still written to watchdog).
$config['system.logging']['error_level'] = 'hide';

// Exclude deprecation warnings from error reporting in production.
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
