<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk\Exception;

/**
 * No chat turn can be served for the requested assistant.
 *
 * Thrown from the processor's `execute()` — before any part is produced — so
 * the caller can still answer with an HTTP error status rather than a
 * successful stream that carries no answer.
 */
final class ChatUnavailableException extends \RuntimeException {}
