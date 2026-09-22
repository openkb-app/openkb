<?php

/**
 * @file
 * Local-laptop environment overrides.
 *
 * Active when PHAPP_ENV=localdev.
 */

$settings['file_chmod_directory'] = octdec(2770);

// Trust the localdev hosts. Backend + decoupled frontend (Nuxt SSR proxy).
$settings['trusted_host_patterns'][] = '^.+\.localdev\.space$';
$settings['trusted_host_patterns'][] = '^localhost$';
$settings['trusted_host_patterns'][] = '^127\.0\.0\.1$';
