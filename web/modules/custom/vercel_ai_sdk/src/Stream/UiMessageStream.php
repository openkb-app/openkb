<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk\Stream;

use Drupal\ai\OperationType\Chat\StreamedChatMessage;
use Drupal\ai\OperationType\Chat\StreamedChatMessageIterator;
use Drupal\ai\OperationType\Chat\StreamedChatMessageInterface;

/**
 * A drupal/ai streamed answer that also carries its UI-message parts.
 *
 * A ChatProcessor hands its answer back as a `ChatOutput`, and a streamed one
 * is a `StreamedChatMessageIteratorInterface` — a sequence of assistant text.
 * The Vercel protocol needs more than text: reasoning, step boundaries and
 * tool parts have no text at all. So each chunk carries its encoded part in
 * metadata under `ui_message`, and its text delta as the chunk text.
 *
 * Consumers pick the view they need. A generic drupal/ai consumer iterating
 * the output reads prose; `ChatController` reads `doIterate()` and re-emits
 * the parts verbatim.
 */
final class UiMessageStream extends StreamedChatMessageIterator {

  /**
   * Metadata key one chunk's encoded UI-message part travels under.
   */
  public const PART_KEY = 'ui_message';

  /**
   * {@inheritdoc}
   */
  public function doIterate(): \Generator {
    foreach ($this->iterator as $part) {
      $message = self::chunk($part);
      $this->messages[] = $message;
      yield $message;
    }
  }

  /**
   * The UI-message part one chunk carries, decoded.
   */
  public static function part(StreamedChatMessageInterface $chunk): array {
    return (array) json_decode((string) ($chunk->getMetadata()[self::PART_KEY] ?? '{}'), TRUE);
  }

  /**
   * One part as a streamed chunk.
   *
   * Built directly rather than through `createStreamedChatMessage()`: that
   * factory holds text back in a URL-safety buffer until a boundary, which
   * would separate a part from the text it announced.
   */
  private static function chunk(array $part): StreamedChatMessage {
    $delta = ($part['type'] ?? '') === 'text-delta' ? (string) ($part['delta'] ?? '') : '';
    return new StreamedChatMessage('assistant', $delta, [self::PART_KEY => UiMessage::encode($part)]);
  }

}
