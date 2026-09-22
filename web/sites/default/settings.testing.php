<?php

/**
 * @file
 * Settings every functional test site gets on top of its generated ones.
 *
 * A test site is served behind the same reverse proxy as the site itself, and
 * has to see HTTPS where the proxy terminates it: the session cookie's name
 * depends on it.
 */

require DRUPAL_ROOT . '/sites/all/reverse-proxy.settings.php';
