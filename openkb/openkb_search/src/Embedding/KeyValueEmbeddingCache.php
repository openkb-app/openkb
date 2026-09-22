<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Embedding;

use Drupal\Core\KeyValueStore\KeyValueFactoryInterface;
use Drupal\Core\KeyValueStore\KeyValueStoreInterface;
use Drupal\Core\State\StateInterface;

/**
 * The embedding cache in a key-value collection.
 */
class KeyValueEmbeddingCache implements EmbeddingCacheInterface {

  public const COLLECTION = 'openkb_search.embeddings';

  /**
   * Where the tally lives. Not in the collection, which the export reads whole.
   */
  private const TALLY = 'openkb_search.embedding_tally';

  /**
   * The collection the vectors live in.
   *
   * @var \Drupal\Core\KeyValueStore\KeyValueStoreInterface
   */
  protected KeyValueStoreInterface $store;

  public function __construct(
    KeyValueFactoryInterface $keyValueFactory,
    private readonly StateInterface $state,
  ) {
    $this->store = $keyValueFactory->get(self::COLLECTION);
  }

  /**
   * {@inheritdoc}
   */
  public function get(string $provider, string $model, string $text, int $dimensions): ?array {
    $entry = $this->store->get(self::key($provider, $model, $text, $dimensions));
    return is_array($entry['vector'] ?? NULL) ? $entry['vector'] : NULL;
  }

  /**
   * {@inheritdoc}
   */
  public function set(string $provider, string $model, string $text, int $dimensions, array $vector): void {
    $this->store->set(self::key($provider, $model, $text, $dimensions), [
      'provider' => $provider,
      'model' => $model,
      'dimensions' => $dimensions,
      'vector' => array_values($vector),
    ]);
  }

  /**
   * {@inheritdoc}
   */
  public function all(): iterable {
    return $this->store->getAll();
  }

  /**
   * {@inheritdoc}
   */
  public function restore(iterable $entries): array {
    $restored = 0;
    $skipped = 0;
    foreach ($entries as $key => $entry) {
      $vector = $entry['vector'] ?? NULL;
      $dimensions = (int) ($entry['dimensions'] ?? 0);
      if (!is_string($key) || !is_array($vector) || count($vector) !== $dimensions) {
        $skipped++;
        continue;
      }
      $this->store->set($key, [
        'provider' => (string) ($entry['provider'] ?? ''),
        'model' => (string) ($entry['model'] ?? ''),
        'dimensions' => $dimensions,
        'vector' => array_values(array_map('floatval', $vector)),
      ]);
      $restored++;
    }
    return ['restored' => $restored, 'skipped' => $skipped];
  }

  /**
   * {@inheritdoc}
   */
  public function record(int $hits, int $misses): void {
    $tally = $this->state->get(self::TALLY);
    if ($tally === NULL) {
      return;
    }
    $this->state->set(self::TALLY, [
      'hits' => (int) ($tally['hits'] ?? 0) + $hits,
      'misses' => (int) ($tally['misses'] ?? 0) + $misses,
    ]);
  }

  /**
   * {@inheritdoc}
   */
  public function tally(bool $reset = FALSE): array {
    $tally = $this->state->get(self::TALLY, []);
    $tally = [
      'hits' => (int) ($tally['hits'] ?? 0),
      'misses' => (int) ($tally['misses'] ?? 0),
    ];
    if ($reset) {
      $this->state->set(self::TALLY, ['hits' => 0, 'misses' => 0]);
    }
    return $tally;
  }

  /**
   * {@inheritdoc}
   */
  public static function key(string $provider, string $model, string $text, int $dimensions): string {
    return $provider . ':' . $model . ':' . $dimensions . ':' . hash('sha256', $text);
  }

}
