<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_test;

use Drupal\ai\OperationType\Chat\StreamedChatMessageIterator;

/**
 * An answer that arrives in pieces, as a real provider's does.
 */
final class StreamedAnswer extends StreamedChatMessageIterator {

  /**
   * The answer, split into the chunks it arrives in.
   *
   * @param array<int, string|\Drupal\vercel_ai_sdk_test\StreamedToolCallDelta> $chunks
   *   The chunks: a string is a piece of the text, a fragment is a piece of a
   *   tool call the answer asks for.
   */
  public static function of(array $chunks): self {
    return new self(new \ArrayIterator($chunks));
  }

  /**
   * {@inheritdoc}
   */
  public function doIterate(): \Generator {
    foreach ($this->iterator as $chunk) {
      yield $chunk instanceof StreamedToolCallDelta
        ? $this->createStreamedChatMessage('assistant', '', [], [$chunk])
        : $this->createStreamedChatMessage('assistant', (string) $chunk, []);
    }
  }

}
