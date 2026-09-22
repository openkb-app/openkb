<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite_test;

use Drupal\ai\OperationType\Chat\StreamedChatMessageIterator;

/**
 * An answer that arrives in pieces, as a real provider's does.
 */
class StreamedAnswer extends StreamedChatMessageIterator {

  /**
   * The answer, split into the chunks it arrives in.
   *
   * @param string[] $chunks
   *   The chunks.
   */
  public static function of(array $chunks): self {
    return new self(new \ArrayIterator($chunks));
  }

  /**
   * {@inheritdoc}
   */
  public function doIterate(): \Generator {
    foreach ($this->iterator as $chunk) {
      yield $this->createStreamedChatMessage('assistant', (string) $chunk, []);
    }
  }

}
