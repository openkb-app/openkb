<?php

declare(strict_types=1);

namespace Drupal\openkb_tools;

/**
 * No chat token can be issued for this account.
 *
 * The message says why, and is told to the caller as a result of their call
 * rather than logged as a fault.
 */
final class ChatIdentityUnavailable extends \RuntimeException {}
