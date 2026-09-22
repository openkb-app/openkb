<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools;

/**
 * What openkb_tools costs a kernel test beyond its own code.
 */
final class SessionRelayModules {

  /**
   * The modules that issuing the relay's own OAuth token needs.
   *
   * A consumer entity carries an image field, hence file and image.
   */
  public const OAUTH = [
    'serialization',
    'file',
    'image',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
  ];

}
