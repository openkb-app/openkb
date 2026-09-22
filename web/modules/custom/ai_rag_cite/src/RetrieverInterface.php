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
   * How a turn nothing narrowed describes what it searched.
   */
  public const WHOLE_BASE = 'the knowledge base';

  /**
   * What this turn searched, as a phrase a sentence can name it by.
   *
   * An answer that found nothing says which scope came back empty, so the
   * retriever that applied the narrowing words it — `the pages of the space
   * “Team Wiki”` — and answers self::WHOLE_BASE where the turn was not
   * narrowed at all.
   *
   * @param array<string, mixed> $context
   *   The caller context this turn arrived with, as the client sent it.
   *
   * @return string
   *   The phrase.
   */
  public function scopeDescription(array $context): string;

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
