<?php

/**
 * @file
 * Trusts the reverse proxy in front of the stack, which terminates TLS.
 *
 * Its X-Forwarded-* headers count when the request comes from one of the
 * addresses or subnets in REVERSE_PROXY_ADDRESSES.
 */

if ($reverse_proxy_addresses = getenv('REVERSE_PROXY_ADDRESSES')) {
  $settings['reverse_proxy'] = TRUE;
  $settings['reverse_proxy_addresses'] = array_map('trim', explode(',', $reverse_proxy_addresses));
}
