<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Embedding;

/**
 * Embeddings by the provider, model, dimension and text that produced them.
 *
 * Indexing asks here before it asks the provider, so re-indexing an unchanged
 * chunk costs nothing and CI never calls OpenAI: the cache is exported to a
 * fixture once and imported before indexing.
 */
interface EmbeddingCacheInterface {

  /**
   * The embedding for a text, or NULL when none is cached.
   *
   * @param string $provider
   *   The AI provider plugin id. Two providers answer the same model id —
   *   the keyless test one among them — and their vectors are not the same
   *   vectors.
   * @param string $model
   *   The embedding model id.
   * @param string $text
   *   The text that was embedded.
   * @param int $dimensions
   *   The dimension the model was asked for; a model answers several, and
   *   they are different vectors.
   *
   * @return list<float>|null
   *   The vector.
   */
  public function get(string $provider, string $model, string $text, int $dimensions): ?array;

  /**
   * Stores an embedding.
   *
   * @param string $provider
   *   The AI provider plugin id.
   * @param string $model
   *   The embedding model id.
   * @param string $text
   *   The text that was embedded.
   * @param int $dimensions
   *   The dimension the model was asked for.
   * @param list<float> $vector
   *   The vector.
   */
  public function set(string $provider, string $model, string $text, int $dimensions, array $vector): void;

  /**
   * Every cached entry, for the export command.
   *
   * @return iterable<string, array{provider: string, model: string, dimensions: int, vector: list<float>}>
   *   Keyed by cache key.
   */
  public function all(): iterable;

  /**
   * Restores entries as all() yields them, for the fixture import.
   *
   * The cache holds no text — the key is a hash of it — so an exported entry
   * can only be put back under the key it was exported as. Overwrites what a
   * key already holds, which makes a re-import a no-op.
   *
   * An entry whose vector is not as long as its own dimensions says is not
   * stored: it would be answered as that model's, and a wrong-length vector
   * reaches the store as a row nothing can search.
   *
   * @param iterable<string, array{provider: string, model: string, dimensions: int, vector: list<float>}> $entries
   *   The entries, keyed by cache key.
   *
   * @return array{restored: int, skipped: int}
   *   How many entries were stored, and how many were not.
   */
  public function restore(iterable $entries): array;

  /**
   * Counts what an embeddings call did, while a tally is running.
   *
   * Does nothing until `tally(TRUE)` starts one: every embeddings call would
   * otherwise rewrite state, and only an indexing run asks what it paid.
   *
   * @param int $hits
   *   Texts answered from the cache.
   * @param int $misses
   *   Texts the provider was asked for.
   */
  public function record(int $hits, int $misses): void;

  /**
   * The tally since it was last started.
   *
   * A run that indexes the seed content and pays for it has a fixture that no
   * longer holds its texts — a chunker change turns every key stale at once.
   *
   * @param bool $reset
   *   Whether to start a new tally, the count returned being the old one.
   *
   * @return array{hits: int, misses: int}
   *   Texts answered from the cache, and texts the provider was asked for.
   */
  public function tally(bool $reset = FALSE): array;

  /**
   * The key one text embeds under: who answered it, how, and a hash of it.
   */
  public static function key(string $provider, string $model, string $text, int $dimensions): string;

}
