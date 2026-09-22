<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_search\Retrieval\ChunkHit;
use Drupal\openkb_search\Retrieval\ChunkRetrieval;
use Drupal\search_api\Entity\Index;
use Drupal\search_api\Item\ItemInterface;

/**
 * A chunk row becomes a hit without anything being loaded behind it.
 *
 * The ai_search backend answers a result item carrying the score and one
 * extra-data key per stored field, and nothing else: no fields are set, and
 * the item id names a chunk, not an entity the datasource can load.
 *
 * @group openkb_search
 */
final class ChunkHitFromRowTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = ['search_api', 'search_api_opensearch', 'ai', 'openkb_schema', 'openkb_search'];

  /**
   * Every field of the hit comes off the row the backend built.
   */
  public function testTheStoredRowIsReadIntoHitFields(): void {
    $hit = $this->hit($this->resultItem([
      'drupal_entity_id' => 'entity:node/12:en',
      'block_id' => 'b-7',
      'title' => 'Release checklist',
      'path' => '/handbook/release-checklist',
      'space' => 'handbook',
      'langcode' => 'en',
      'content' => 'Tag the release, then announce it.',
      'heading_path' => ['Handbook', 'Releases'],
      'part' => 2,
      'cites' => ['42', '42#b-4f2a'],
    ]));

    $this->assertSame('entity:node/12:en', $hit->entityId);
    $this->assertSame('b-7', $hit->blockId);
    $this->assertSame('Release checklist', $hit->title);
    $this->assertSame('handbook', $hit->space);
    $this->assertSame('en', $hit->langcode);
    $this->assertSame('Tag the release, then announce it.', $hit->excerpt);
    $this->assertSame(['Handbook', 'Releases'], $hit->headingPath);
    $this->assertSame(2, $hit->part);
    $this->assertSame(0.75, $hit->score);
    $this->assertSame('/handbook/release-checklist#b-7', $hit->anchoredPath());
    $this->assertSame('Handbook › Releases', $hit->headingLine());
    $this->assertSame(['42', '42#b-4f2a'], $hit->cites);
  }

  /**
   * The lead section's row names the block it opens on, like any other.
   *
   * Its heading path is the page's own heading alone, so the block is the
   * title heading — which the page renders as its own `<h1>`.
   */
  public function testTheLeadSectionRowKeepsItsBlockId(): void {
    $hit = $this->hit($this->resultItem([
      'drupal_entity_id' => 'entity:node/12:en',
      'block_id' => 'b-7',
      'title' => 'Release checklist',
      'path' => '/handbook/release-checklist',
      'heading_path' => ['Release checklist'],
    ]));

    $this->assertSame('b-7', $hit->blockId);
    $this->assertSame('/handbook/release-checklist#b-7', $hit->anchoredPath());
    $this->assertSame('Release checklist', $hit->headingLine());
  }

  /**
   * A section under a sub-heading keeps the block it opens on.
   */
  public function testSectionUnderSubHeadingKeepsItsBlockId(): void {
    $hit = $this->hit($this->resultItem([
      'drupal_entity_id' => 'entity:node/12:en',
      'block_id' => 'b-7',
      'title' => 'Release checklist',
      'path' => '/handbook/release-checklist',
      'heading_path' => ['Release checklist', 'Before the release'],
    ]));

    $this->assertSame('b-7', $hit->blockId);
    $this->assertSame('/handbook/release-checklist#b-7', $hit->anchoredPath());
  }

  /**
   * A row whose page is gone still answers, because nothing is loaded.
   */
  public function testTheRowAnswersWithoutItsPage(): void {
    $hit = $this->hit($this->resultItem([
      'drupal_entity_id' => 'entity:node/404:en',
      'block_id' => 'b-1',
      'title' => 'Gone',
    ]));

    $this->assertSame('entity:node/404:en', $hit->entityId);
    $this->assertSame('', $hit->path);
    $this->assertSame([], $hit->headingPath);
    $this->assertSame(0, $hit->part);
    $this->assertSame([], $hit->cites);
  }

  /**
   * A result item as SearchApiAiSearchBackend::search() builds one.
   *
   * @param array<string, mixed> $row
   *   The stored row, as extractMetadata() spreads it over extra data.
   */
  protected function resultItem(array $row): ItemInterface {
    // The index defines the attributes, so reading one as a field would
    // extract it and load the page behind the id.
    $index = Index::create([
      'id' => 'kb_chunks',
      'name' => 'KB chunks',
      'datasource_settings' => ['entity:node' => []],
      'field_settings' => [
        'title' => [
          'label' => 'Title',
          'datasource_id' => 'entity:node',
          'property_path' => 'title',
          'type' => 'string',
        ],
        'space' => [
          'label' => 'Space',
          'datasource_id' => 'entity:node',
          'property_path' => 'field_space',
          'type' => 'string',
        ],
      ],
    ]);
    $item = $this->container->get('search_api.fields_helper')
      ->createItem($index, $row['drupal_entity_id'] . ':0');
    $item->setScore(0.75);
    foreach ($row as $key => $value) {
      $item->setExtraData($key, $value);
    }
    return $item;
  }

  /**
   * The hit the retrieval service reads off a row.
   */
  protected function hit(ItemInterface $item): ChunkHit {
    $retrieval = new class(
      $this->container->get('entity_type.manager'),
      $this->container->get('config.factory'),
      $this->container->get('ai.provider'),
    ) extends ChunkRetrieval {

      /**
       * Reads one row, which is what this test is about.
       */
      public function read(ItemInterface $item): ChunkHit {
        return $this->toHit($item);
      }

    };
    return $retrieval->read($item);
  }

}
