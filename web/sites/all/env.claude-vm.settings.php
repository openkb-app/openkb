<?php

/**
 * @file
 * claude-vm Lima VM environment overrides.
 *
 * Active when PHAPP_ENV=claude-vm. Drupal runs on host port 8081,
 * the Nuxt decoupled frontend on host port 8091.
 */

$settings['file_chmod_directory'] = octdec(2770);

// Trust the VM-forwarded hosts. The exact host depends on the operator's
// /etc/hosts and the VM's HOST_IP; cover the common forms.
$settings['trusted_host_patterns'][] = '^localhost(:\d+)?$';
$settings['trusted_host_patterns'][] = '^127\.0\.0\.1(:\d+)?$';
$settings['trusted_host_patterns'][] = '^.+\.localdev\.space$';
$settings['trusted_host_patterns'][] = '^.+\.lima\.internal$';
