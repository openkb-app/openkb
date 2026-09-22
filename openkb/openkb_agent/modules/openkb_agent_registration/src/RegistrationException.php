<?php

declare(strict_types=1);

namespace Drupal\openkb_agent_registration;

/**
 * A registration the policy refused, in the shape RFC 7591 §3.2.2 defines.
 *
 * The `error` code is part of the wire contract — a client reads it to tell a
 * malformed redirect URI from unusable metadata — so it is carried here rather
 * than reconstructed from the message at the controller.
 */
final class RegistrationException extends \RuntimeException {

  public function __construct(
    public readonly string $error,
    string $description,
    public readonly int $statusCode = 400,
  ) {
    parent::__construct($description);
  }

}
