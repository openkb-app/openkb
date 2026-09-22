<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_mock;

use Drupal\ai\OperationType\Chat\StreamedChatMessageIterator;

/**
 * A mock answer arriving in pieces, as a real provider's does.
 *
 * Paced, because a turn that leaves in one PHP tick reads on the wire exactly
 * like a stack that buffered a real one.
 */
final class MockStream extends StreamedChatMessageIterator {

  /**
   * Text-delta size, in characters — the answer streams in several frames.
   */
  private const CHUNK_SIZE = 16;

  /**
   * Pause between two frames, in milliseconds.
   */
  private int $delayMs = 0;

  /**
   * The stream of one answer, paced.
   *
   * @param \Drupal\vercel_ai_sdk_mock\MockAnswer $answer
   *   The answer to stream.
   * @param int $delayMs
   *   Pause between two frames, in milliseconds; 0 leaves it unpaced.
   */
  public static function of(MockAnswer $answer, int $delayMs = 0): self {
    $chunks = $answer->text === '' ? [''] : str_split($answer->text, self::CHUNK_SIZE);
    $stream = new self(new \ArrayIterator($chunks));
    $stream->delayMs = $delayMs;
    // Merged once the stream has ended, because drupal/ai stamps the call's
    // own metadata over the iterator's when the answer starts.
    $stream->addCallback(static function () use ($stream, $answer): void {
      $stream->setMetadata(array_merge($stream->getMetadata(), $answer->metadata));
    });
    return $stream;
  }

  /**
   * {@inheritdoc}
   */
  public function doIterate(): \Generator {
    $first = TRUE;
    foreach ($this->iterator as $chunk) {
      // The pause separates two frames, so the turn's first byte is not held.
      if (!$first && $this->delayMs > 0) {
        usleep($this->delayMs * 1000);
      }
      $first = FALSE;
      // The frame as its own raw payload, in a list so the accumulated raw
      // output is the whole stream: that is what `ai_logging` stores as the
      // response, and a chunk carrying none leaves it empty.
      yield $this->createStreamedChatMessage('assistant', (string) $chunk, [], NULL, [$chunk]);
    }
  }

}
