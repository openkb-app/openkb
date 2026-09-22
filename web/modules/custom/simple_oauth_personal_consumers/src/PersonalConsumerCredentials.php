<?php

declare(strict_types=1);

namespace Drupal\simple_oauth_personal_consumers;

use Drupal\consumers\Entity\ConsumerInterface;

/**
 * Result of provisioning a personal consumer: entity plus one-time secret.
 *
 * The plaintext secret exists only in this object — the consumer stores a
 * hash. Display it once, then drop it.
 */
final class PersonalConsumerCredentials {

  public function __construct(
    public readonly ConsumerInterface $consumer,
    public readonly string $clientId,
    public readonly string $secret,
  ) {}

}
