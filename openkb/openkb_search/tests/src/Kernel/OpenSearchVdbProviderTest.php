<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\ai\Enum\VdbSimilarityMetrics;
use Drupal\search_api\Entity\Index;

/**
 * What the OpenSearch vector store does with a chunk row.
 *
 * The chunk index answers on attributes the strategy writes beside the
 * vector, so the store has to keep them filterable and hold one row per
 * chunk across a reindex. Every case runs against the live OpenSearch.
 *
 * @group openkb_search
 */
final class OpenSearchVdbProviderTest extends KernelTestBase {

  use RequiresOpenSearchTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'key',
    'search_api',
    'search_api_opensearch',
    'ai',
    'ai_search',
    'ai_vdb_provider_opensearch',
    // The document types a search narrows by come from the frontmatter
    // schema, which openkb_search's PageTypes reads.
    'openkb_schema',
    'openkb_search',
  ];

  /**
   * The vector store under test.
   *
   * @var \Drupal\ai\AiVdbProviderInterface
   */
  protected $provider;

  /**
   * The collection each test method owns.
   */
  protected string $collection;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();

    $this->config('ai_vdb_provider_opensearch.settings')
      ->set('connector', 'standard')
      ->set('connector_config', [
        'url' => 'http://opensearch:9200',
        'ssl_verification' => FALSE,
      ])
      ->set('vdb_config', ['engine' => 'faiss'])
      ->save();

    $this->provider = $this->container->get('ai.vdb_provider')->createInstance('opensearch');
    $this->requireOpenSearch();

    $this->collection = 'chunks_' . strtolower($this->databasePrefix);
    $this->provider->createCollection($this->collection, 4, VdbSimilarityMetrics::CosineSimilarity);
  }

  /**
   * {@inheritdoc}
   */
  protected function tearDown(): void {
    if (isset($this->provider) && isset($this->collection) && $this->serverAvailable()) {
      try {
        $this->provider->dropCollection($this->collection);
      }
      catch (\Exception) {
        // The collection was never created.
      }
    }
    parent::tearDown();
  }

  /**
   * The provider answers, which is what requireOpenSearch() asks.
   */
  protected function serverAvailable(): bool {
    return isset($this->provider) && $this->provider->ping();
  }

  /**
   * The mapping declares every attribute, so a term filter matches a value.
   */
  public function testAnAttributeIsMappedForTermFiltering(): void {
    $this->insertChunk('entity:node/1:en', 'chunk-1', ['space' => 'handbook']);
    $this->refresh();

    $mapping = $this->mapping();
    $this->assertSame('keyword', $mapping['space']['type'] ?? NULL);
    $this->assertSame('keyword', $mapping['drupal_entity_id']['type'] ?? NULL);

    $this->assertSame(['chunk-1'], $this->blockIdsMatching([
      'term' => ['space' => 'handbook'],
    ]));
  }

  /**
   * Re-indexing an item leaves one row per chunk and drops what it lost.
   */
  public function testReindexingAnItemLeavesOneRowPerChunk(): void {
    $this->insertChunk('entity:node/1:en', 'chunk-1');
    $this->insertChunk('entity:node/1:en', 'chunk-2');
    $this->refresh();

    // The page is edited down to one section, so the second row has to go.
    $this->deleteItem('entity:node/1:en');
    $this->insertChunk('entity:node/1:en', 'chunk-1');
    $this->refresh();

    $this->assertSame(['chunk-1'], $this->blockIdsMatching(['match_all' => (object) []]));
  }

  /**
   * A second save of a page sees what the first one's delete removed.
   *
   * Every save indexes its own item, so the delete that precedes an insert
   * runs while another save of the same page may still be writing. It asks
   * OpenSearch to refresh, so the next delete's snapshot holds the rows as
   * they are, and to skip a row whose version moved rather than failing the
   * whole request — which reaches the editor as a 500 on the save.
   */
  public function testSavingOnePageTwiceLeavesOneRowPerChunk(): void {
    $this->insertChunk('entity:node/1:en', 'chunk-1');
    $this->insertChunk('entity:node/1:en', 'chunk-2');
    $this->refresh();

    // Two saves back to back, with nothing refreshing in between.
    $this->deleteItem('entity:node/1:en');
    $this->insertChunk('entity:node/1:en', 'chunk-1');
    $this->deleteItem('entity:node/1:en');
    $this->insertChunk('entity:node/1:en', 'chunk-1');
    $this->refresh();

    $this->assertSame(['chunk-1'], $this->blockIdsMatching(['match_all' => (object) []]));
  }

  /**
   * A hit carries every stored attribute, not only the four ai_search names.
   */
  public function testTheReadPathAnswersTheStoredAttributes(): void {
    $this->insertChunk('entity:node/1:en', 'chunk-1', [
      'space' => 'handbook',
      'title' => 'Onboarding',
      'path' => '/handbook/onboarding',
      'content' => 'Sign the contract.',
    ]);
    $this->refresh();

    // The output fields ai_search asks for, which is all it ever asks for.
    $rows = $this->provider->vectorSearch(
      $this->collection,
      [0.1, 0.2, 0.3, 0.4],
      ['id', 'drupal_entity_id', 'drupal_long_id', 'content'],
      $this->chunkIndex()->query(),
      $this->provider->prepareFilters($this->chunkIndex()->query()),
    );

    $this->assertCount(1, $rows);
    $this->assertSame('handbook', $rows[0]['space'] ?? NULL);
    $this->assertSame('Onboarding', $rows[0]['title'] ?? NULL);
    $this->assertSame('/handbook/onboarding', $rows[0]['path'] ?? NULL);
    $this->assertSame('chunk-1', $rows[0]['block_id'] ?? NULL);
    $this->assertArrayNotHasKey('vector', $rows[0]);
  }

  /**
   * Two indexes on one collection each keep their row for the same entity.
   */
  public function testTwoIndexesKeepTheirOwnRowForOneEntity(): void {
    $this->insertChunk('entity:node/1:en', 'chunk-1', ['index_id' => 'kb_chunks']);
    $this->insertChunk('entity:node/1:en', 'chunk-1', ['index_id' => 'kb_other']);
    $this->refresh();

    $rows = $this->rowsMatching(['match_all' => (object) []], ['index_id']);
    $indexes = array_column($rows, 'index_id');
    sort($indexes);
    $this->assertSame(['kb_chunks', 'kb_other'], $indexes);
  }

  /**
   * A delete for one index leaves the other index's row for the same entity.
   */
  public function testDeletingForOneIndexKeepsTheOtherIndexsRow(): void {
    $this->insertChunk('entity:node/1:en', 'chunk-1', ['index_id' => 'kb_chunks']);
    $this->insertChunk('entity:node/1:en', 'chunk-1', ['index_id' => 'kb_other']);
    $this->refresh();

    $this->provider->deleteIndexItems([
      'database_settings' => [
        'database_name' => 'default',
        'collection' => $this->collection,
      ],
    ], $this->chunkIndex(), ['entity:node/1:en']);
    $this->refresh();

    $rows = $this->rowsMatching(['match_all' => (object) []], ['index_id']);
    $this->assertSame(['kb_other'], array_column($rows, 'index_id'));
  }

  /**
   * Drops every row of an item, the way the backend does before re-indexing.
   */
  protected function deleteItem(string $entityId): void {
    $this->provider->deleteItems([
      'database_settings' => [
        'database_name' => 'default',
        'collection' => $this->collection,
      ],
    ], [$entityId]);
  }

  /**
   * Only the collections this provider made are offered as collections.
   */
  public function testGetCollectionsListsOnlyItsOwnIndices(): void {
    // Both under the provider's own prefix, so the mapping decides and not
    // the name: the marker excludes the foreign index, and the vector field
    // still admits one made before the marker existed.
    $foreign = 'foreign_' . strtolower($this->databasePrefix);
    $legacy = 'legacy_' . strtolower($this->databasePrefix);
    $this->client()->indices()->create(['index' => 'default_' . $foreign]);
    $this->client()->indices()->create([
      'index' => 'default_' . $legacy,
      'body' => [
        'settings' => ['index' => ['knn' => TRUE]],
        'mappings' => [
          'properties' => ['vector' => ['type' => 'knn_vector', 'dimension' => 4]],
        ],
      ],
    ]);
    try {
      $collections = $this->provider->getCollections();
      $this->assertContains($this->collection, $collections);
      $this->assertContains($legacy, $collections);
      $this->assertNotContains($foreign, $collections);
    }
    finally {
      $this->client()->indices()->delete(['index' => 'default_' . $foreign]);
      $this->client()->indices()->delete(['index' => 'default_' . $legacy]);
    }
  }

  /**
   * Two conditions and the index scope survive as one filter OpenSearch takes.
   */
  public function testConditionsAndTheIndexScopeBuildOneFilter(): void {
    $this->insertChunk('entity:node/1:en', 'chunk-1', ['space' => 'handbook']);
    $this->insertChunk('entity:node/2:en', 'chunk-2', ['space' => 'private']);
    $this->insertChunk('entity:node/3:en', 'chunk-3', ['space' => 'handbook', 'index_id' => 'other_index']);
    $this->refresh();

    $query = $this->chunkIndex()->query();
    $query->addCondition('space', 'handbook');
    $query->addCondition('langcode', 'en');

    $filter = $this->provider->prepareFilters($query);

    $this->assertSame(['bool'], array_keys($filter));
    $this->assertCount(2, $filter['bool']['filter']);
    $this->assertSame(['chunk-1'], $this->blockIdsMatching($filter));
  }

  /**
   * An index the provider can read fields and an id off, never saved.
   */
  protected function chunkIndex(): Index {
    return Index::create([
      'id' => 'kb_chunks',
      'name' => 'KB chunks',
      'field_settings' => [
        'space' => ['label' => 'Space', 'property_path' => 'space', 'type' => 'string'],
        'langcode' => ['label' => 'Language', 'property_path' => 'langcode', 'type' => 'string'],
      ],
    ]);
  }

  /**
   * Writes one chunk row the way AiVdbProviderClientBase::indexItems does.
   */
  protected function insertChunk(string $entityId, string $blockId, array $attributes = []): void {
    $this->provider->insertIntoCollection($this->collection, $attributes + [
      'drupal_long_id' => $entityId . ':' . $blockId,
      'drupal_entity_id' => $entityId,
      'vector' => [0.1, 0.2, 0.3, 0.4],
      'block_id' => $blockId,
      'langcode' => 'en',
      'index_id' => 'kb_chunks',
      'server_id' => 'ai_chunks',
    ]);
  }

  /**
   * The block ids of every row a query matches, sorted.
   *
   * @return string[]
   *   Block ids.
   */
  protected function blockIdsMatching(array $query): array {
    $ids = array_column($this->rowsMatching($query, ['block_id']), 'block_id');
    sort($ids);
    return $ids;
  }

  /**
   * The named stored fields of every row a query matches.
   *
   * @param array $query
   *   The OpenSearch query.
   * @param string[] $source
   *   The stored fields to read.
   *
   * @return array<int, array>
   *   One array of stored fields per row.
   */
  protected function rowsMatching(array $query, array $source): array {
    $result = $this->client()->search([
      'index' => 'default_' . $this->collection,
      'body' => ['size' => 50, 'query' => $query, '_source' => $source],
    ]);
    return array_map(fn($hit) => $hit['_source'], $result['hits']['hits']);
  }

  /**
   * The collection's field mapping.
   *
   * @return array<string, array>
   *   Field name to mapping.
   */
  protected function mapping(): array {
    $index = 'default_' . $this->collection;
    $response = $this->client()->indices()->getMapping(['index' => $index]);
    return $response[$index]['mappings']['properties'] ?? [];
  }

  /**
   * Makes what was written visible to a query.
   */
  protected function refresh(): void {
    $this->client()->indices()->refresh(['index' => 'default_' . $this->collection]);
  }

  /**
   * The OpenSearch client the provider talks through.
   */
  protected function client(): object {
    return $this->provider->getClient();
  }

}
