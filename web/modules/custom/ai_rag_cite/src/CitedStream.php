<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite;

use Drupal\ai\OperationType\Chat\StreamedChatMessage;
use Drupal\ai\OperationType\Chat\StreamedChatMessageInterface;
use Drupal\ai\OperationType\Chat\StreamedChatMessageIterator;
use Drupal\ai\OperationType\Chat\StreamedChatMessageIteratorInterface;

/**
 * A streamed answer with the `[n]` markers that name no source taken out.
 *
 * The reader sees a streamed answer as it is written, so a marker has to be
 * judged before the answer ends. A chunk ending part-way into one is held back
 * until it closes; nothing else ever waits.
 */
class CitedStream extends StreamedChatMessageIterator {

  /**
   * What the end of a chunk cannot be judged on yet.
   *
   * A marker still arriving, and the space that may turn out to be the one in
   * front of it — which goes with a dropped marker.
   */
  private const UNJUDGED_TAIL = '/ ?\\[\\d*$| $/';

  /**
   * The answer, as the provider streams it.
   */
  private StreamedChatMessageIteratorInterface $answer;

  /**
   * The citation pass.
   */
  private Grounding $grounding;

  /**
   * How many sources the turn was grounded on.
   */
  private int $sources = 0;

  /**
   * Text held back until the next chunk says what it is.
   */
  private string $held = '';

  /**
   * The answer, with only the markers that name one of the sources left.
   *
   * @param \Drupal\ai\OperationType\Chat\StreamedChatMessageIteratorInterface $answer
   *   The answer, as the provider streams it.
   * @param \Drupal\ai_rag_cite\Grounding $grounding
   *   The citation pass.
   * @param int $sources
   *   How many sources the turn was grounded on.
   */
  public static function of(StreamedChatMessageIteratorInterface $answer, Grounding $grounding, int $sources): static {
    $stream = new static($answer);
    $stream->answer = $answer;
    $stream->grounding = $grounding;
    $stream->sources = $sources;
    return $stream;
  }

  /**
   * {@inheritdoc}
   */
  public function doIterate(): \Generator {
    // `ProviderProxy` attaches the call to whatever it is handed back, which
    // is this; the stream that made the call is the one that reports it.
    $this->handOver();

    $role = 'assistant';
    foreach ($this->answer as $chunk) {
      $role = $chunk->getRole() ?: $role;
      $text = $this->held . $chunk->getText();
      $this->held = '';
      if (preg_match(self::UNJUDGED_TAIL, $text, $match, PREG_OFFSET_CAPTURE)) {
        [$this->held, $offset] = $match[0];
        $text = substr($text, 0, $offset);
      }
      yield $this->keep(new StreamedChatMessage(
        $role,
        $this->grounding->stripOutOfRangeMarkers($text, $this->sources),
        $chunk->getMetadata(),
        $chunk->getTools(),
        $chunk->getRaw(),
      ));
    }
    // An answer ending inside the tail never closed a marker there.
    if ($this->held !== '') {
      yield $this->keep(new StreamedChatMessage($role, $this->held, []));
    }
  }

  /**
   * {@inheritdoc}
   *
   * The provider's own stream reports the turn; see doIterate().
   */
  public function triggerEvent(): void {
  }

  /**
   * Hands the answer what this stream was handed about the call.
   */
  private function handOver(): void {
    $this->answer->setInput($this->input);
    $this->answer->setProviderId((string) $this->providerId);
    $this->answer->setModelId((string) $this->modelId);
    $this->answer->setProviderConfiguration($this->providerConfiguration);
    $this->answer->setTags($this->tags);
    $this->answer->setRequestThreadId($this->requestThreadId ?? '');
  }

  /**
   * Records a chunk as part of the answer, and hands it on.
   */
  private function keep(StreamedChatMessageInterface $chunk): StreamedChatMessageInterface {
    $this->messages[] = $chunk;
    return $chunk;
  }

}
