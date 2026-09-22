<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite;

use Drupal\Component\Plugin\ConfigurableInterface;
use Drupal\Component\Plugin\PluginInspectionInterface;

/**
 * Answers the passages a question can be grounded on.
 */
interface RetrieverInterface extends PluginInspectionInterface, ConfigurableInterface {

  /**
   * The passages that match a question, best first.
   *
   * Runs as the account asking, so whatever access the source of the passages
   * enforces is the access the answer is held to.
   *
   * @param string $query
   *   What the account asked.
   * @param array<string, mixed> $context
   *   The caller context this turn arrived with, as the client sent it. Its
   *   keys are the retriever's own to read; nothing here interprets them.
   *
   * @return \Drupal\ai_rag_cite\ValueObject\Source[]
   *   The passages.
   *
   * @throws \Drupal\ai_rag_cite\RetrieverException
   *   When the passages cannot be reached at all.
   */
  public function retrieve(string $query, array $context = []): array;

}
