<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite_test\Plugin\Retriever;

use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\ai_rag_cite\Attribute\Retriever;
use Drupal\ai_rag_cite\RetrieverBase;
use Drupal\ai_rag_cite\RetrieverException;

/**
 * A retriever whose answers the test decides.
 *
 * Static, because the plugin is built by the manager inside the subscriber and
 * a test never holds the instance. Reset every property in setUp().
 */
#[Retriever(
  id: 'fake',
  label: new TranslatableMarkup('Fake'),
)]
class FakeRetriever extends RetrieverBase {

  /**
   * What the next retrieval answers.
   *
   * @var \Drupal\ai_rag_cite\ValueObject\Source[]
   */
  public static array $sources = [];

  /**
   * Whether the next retrieval fails instead of answering.
   */
  public static bool $unavailable = FALSE;

  /**
   * The query of every retrieval, in order.
   *
   * @var string[]
   */
  public static array $queries = [];

  /**
   * The caller context of every retrieval, in order.
   *
   * @var array<int, array<string, mixed>>
   */
  public static array $contexts = [];

  /**
   * {@inheritdoc}
   */
  public function retrieve(string $query, array $context = []): array {
    self::$queries[] = $query;
    self::$contexts[] = $context;
    if (self::$unavailable) {
      throw new RetrieverException('Nothing to retrieve from.');
    }
    return self::$sources;
  }

}
