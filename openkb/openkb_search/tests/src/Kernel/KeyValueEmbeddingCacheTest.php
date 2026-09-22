<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_search\Embedding\EmbeddingCacheInterface;

/**
 * The embedding cache answers what was stored, by model, dimension and text.
 *
 * @group openkb_search
 */
final class KeyValueEmbeddingCacheTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = ['search_api', 'search_api_opensearch', 'openkb_schema', 'openkb_search'];

  /**
   * A vector is answered for what it was stored under, and nothing else.
   */
  public function testStoredVectorIsAnsweredForTheSameModelAndTextOnly(): void {
    $cache = $this->container->get(EmbeddingCacheInterface::class);

    $this->assertNull($cache->get('openai', 'text-embedding-3-small', 'Release checklist', 512));
    $cache->set('openai', 'text-embedding-3-small', 'Release checklist', 512, [0.1, 0.2]);

    $this->assertSame([0.1, 0.2], $cache->get('openai', 'text-embedding-3-small', 'Release checklist', 512));
    $this->assertNull($cache->get('openai', 'text-embedding-3-small', 'release checklist', 512));
    $this->assertNull($cache->get('openai', 'other-model', 'Release checklist', 512));
    $this->assertCount(1, iterator_to_array($cache->all()));
  }

  /**
   * Another provider answering the same model answers other vectors.
   *
   * The keyless test provider answers `text-embedding-3-small` too, so without
   * the provider in the key a dev environment's made-up vectors would be read
   * as OpenAI's — and exported to the fixture as OpenAI's.
   */
  public function testTheProviderIsPartOfWhatIsCached(): void {
    $cache = $this->container->get(EmbeddingCacheInterface::class);

    $cache->set('openai', 'text-embedding-3-small', 'Release checklist', 512, [0.1, 0.2]);

    $this->assertNull($cache->get('openkb_hash', 'text-embedding-3-small', 'Release checklist', 512));
  }

  /**
   * An entry is restored only when its vector is as long as it claims.
   *
   * A fixture written at another dimension would otherwise be answered as this
   * model's, and reach the store as a row nothing can search.
   */
  public function testRestoreLeavesOutTheWrongVectorLength(): void {
    $cache = $this->container->get(EmbeddingCacheInterface::class);

    $counts = $cache->restore([
      $cache::key('openai', 'text-embedding-3-small', 'Release checklist', 2) => [
        'provider' => 'openai',
        'model' => 'text-embedding-3-small',
        'dimensions' => 2,
        'vector' => [0.1, 0.2],
      ],
      $cache::key('openai', 'text-embedding-3-small', 'Onboarding', 2) => [
        'provider' => 'openai',
        'model' => 'text-embedding-3-small',
        'dimensions' => 2,
        'vector' => [0.1, 0.2, 0.3],
      ],
    ]);

    $this->assertSame(['restored' => 1, 'skipped' => 1], $counts);
    $this->assertSame([0.1, 0.2], $cache->get('openai', 'text-embedding-3-small', 'Release checklist', 2));
    $this->assertNull($cache->get('openai', 'text-embedding-3-small', 'Onboarding', 2));
  }

  /**
   * The tally counts what was answered from the cache and what was not.
   */
  public function testTheTallyCountsHitsAndMissesUntilItIsReset(): void {
    $cache = $this->container->get(EmbeddingCacheInterface::class);

    $cache->tally(TRUE);
    $cache->record(3, 0);
    $cache->record(0, 2);
    $this->assertSame(['hits' => 3, 'misses' => 2], $cache->tally(TRUE));
    $this->assertSame(['hits' => 0, 'misses' => 0], $cache->tally());
  }

  /**
   * Outside a tally nothing is counted, so no call writes state.
   */
  public function testNothingIsCountedBeforeTheTallyStarts(): void {
    $cache = $this->container->get(EmbeddingCacheInterface::class);
    $state = $this->container->get('state');

    $cache->record(3, 2);

    $this->assertNull($state->get('openkb_search.embedding_tally'));
    $this->assertSame(['hits' => 0, 'misses' => 0], $cache->tally());
  }

  /**
   * The same model at another dimension is another vector, not this one.
   */
  public function testTheDimensionIsPartOfWhatIsCached(): void {
    $cache = $this->container->get(EmbeddingCacheInterface::class);

    $cache->set('openai', 'text-embedding-3-small', 'Release checklist', 512, [0.1, 0.2]);

    $this->assertNull($cache->get('openai', 'text-embedding-3-small', 'Release checklist', 1536));
  }

}
