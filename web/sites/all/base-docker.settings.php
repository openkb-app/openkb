<?php

/**
 * @file
 * Settings for the docker stack, all read from the environment.
 *
 * Loaded when PHAPP_ENV_TYPE=docker, which is also the default.
 */

$databases['default']['default'] = [
  'driver' => 'mysql',
  'database' => getenv('MARIADB_DATABASE') ?: 'drupal',
  'username' => getenv('MARIADB_USER') ?: 'drupal',
  'password' => getenv('MARIADB_PASSWORD') ?: 'drupal',
  'host' => getenv('MARIADB_HOST') ?: 'mariadb',
  'port' => getenv('MARIADB_PORT') ?: 3306,
  'prefix' => '',
  'collation' => 'utf8mb4_general_ci',
];

require __DIR__ . '/reverse-proxy.settings.php';

// Drupal and the frontend are two hosts, and the frontend hands Drupal's
// session cookie to the browser. SESSION_COOKIE_DOMAIN scopes it to their
// common parent domain; services_env_parameter applies it to the container.
if ($cookie_domain = getenv('SESSION_COOKIE_DOMAIN')) {
  $_SERVER['DRUPAL_SERVICE_session__storage__options___cookie_domain'] ??= $cookie_domain;
}

// The image's healthcheck asks the server on the loopback address.
$settings['trusted_host_patterns'][] = '^127\.0\.0\.1$';

// The cluster behind the vector store.
if ($opensearch_url = getenv('OPENSEARCH_URL')) {
  $config['ai_vdb_provider_opensearch.settings']['connector_config']['url'] = $opensearch_url;
}
