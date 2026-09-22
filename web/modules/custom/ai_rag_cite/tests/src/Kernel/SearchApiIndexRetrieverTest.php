<?php

declare(strict_types=1);

namespace Drupal\Tests\ai_rag_cite\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\node\Traits\ContentTypeCreationTrait;
use Drupal\Tests\node\Traits\NodeCreationTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\ai_rag_cite\RetrieverException;
use Drupal\ai_rag_cite\RetrieverInterface;
use Drupal\node\NodeInterface;
use Drupal\ai_rag_cite_test\EventSubscriber\ProcessedFieldValues;
use Drupal\path_alias\Entity\PathAlias;
use Drupal\search_api\Entity\Index;
use Drupal\search_api\Entity\Server;

/**
 * What the shipped retriever answers, and where it reads it from.
 *
 * @group ai_rag_cite
 */
final class SearchApiIndexRetrieverTest extends KernelTestBase {

  use ContentTypeCreationTrait;
  use NodeCreationTrait;
  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'ai',
    'ai_assistant_api',
    'ai_rag_cite',
    'ai_rag_cite_test',
    'field',
    'filter',
    'key',
    'node',
    'path_alias',
    'search_api',
    'search_api_db',
    'system',
    'text',
    'user',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('node');
    $this->installEntitySchema('user');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('search_api_task');
    $this->installSchema('search_api', ['search_api_item']);
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['field', 'filter', 'node', 'search_api']);
    $this->createContentType(['type' => 'page']);
    $this->setCurrentUser($this->createUser(['access content']));

    Server::create([
      'id' => 'db',
      'name' => 'Database',
      'backend' => 'search_api_db',
      'backend_config' => ['database' => 'default:default'],
    ])->save();
    Index::create([
      'id' => 'pages',
      'name' => 'Pages',
      'status' => TRUE,
      'server' => 'db',
      'datasource_settings' => ['entity:node' => []],
      // The index processes what it stores, as every real index does: it is
      // reading a source off those values that this proves the plugin avoids.
      'processor_settings' => [
        'html_filter' => [],
        'ignorecase' => [],
        'tokenizer' => [],
      ],
      'field_settings' => [
        'title' => [
          'label' => 'Title',
          'datasource_id' => 'entity:node',
          'property_path' => 'title',
          'type' => 'text',
        ],
        'body' => [
          'label' => 'Body',
          'datasource_id' => 'entity:node',
          'property_path' => 'body:value',
          'type' => 'text',
        ],
      ],
    ])->save();
  }

  /**
   * A source is read off the page, not off what the index made of it.
   */
  public function testTheSourceIsReadOffThePageNotTheIndex(): void {
    $this->page('Release checklist', '<p>Cut the <strong>tag</strong>, then announce it.</p>', '/handbook/release');
    // A backend that answers the values its processors stored, as a real one
    // does: reading a source off those is what this proves the plugin avoids.
    $this->container->get('state')->set(ProcessedFieldValues::PROCESS, TRUE);

    $sources = $this->retriever()->retrieve('release');

    $this->assertCount(1, $sources);
    $this->assertSame('Release checklist', $sources[0]->title);
    $this->assertSame('/handbook/release', $sources[0]->path);
    // Markup is dropped, and the prose is the page's own.
    $this->assertSame('Cut the tag, then announce it.', $sources[0]->excerpt);
    $this->assertGreaterThan(0.0, $sources[0]->score);
  }

  /**
   * A source names the page it belongs to, so the per-page cap can count.
   */
  public function testTheSourceNamesThePageItBelongsTo(): void {
    $node = $this->page('Release checklist', 'Cut the tag.', '/handbook/release');

    $this->assertSame('node:' . $node->id(), $this->retriever()->retrieve('release')[0]->entityId);
  }

  /**
   * A question is a fulltext search: a page matching one of its words is a hit.
   */
  public function testTheQuestionMatchesOnAnyOfItsWords(): void {
    $this->page('Deploy on Pantheon', 'Push the branch.', '/handbook/pantheon');

    $sources = $this->retriever()->retrieve('how do I deploy on pantheon?');

    $this->assertCount(1, $sources);
    $this->assertSame('Deploy on Pantheon', $sources[0]->title);
  }

  /**
   * A question sharing no word with any page is answered nothing.
   */
  public function testTheQuestionMatchingNoWordAnswersNothing(): void {
    $this->page('Deploy on Pantheon', 'Push the branch.', '/handbook/pantheon');

    $this->assertSame([], $this->retriever()->retrieve('espresso machine descaling'));
  }

  /**
   * Retrieval answers no more candidates than it is configured to.
   */
  public function testRetrievalAnswersAtMostTheConfiguredCandidates(): void {
    foreach (range(1, 3) as $i) {
      $this->page('Release note ' . $i, 'Cut the tag.', '/handbook/release-' . $i);
    }

    $this->assertCount(2, $this->retriever(['top_k' => 2])->retrieve('release'));
  }

  /**
   * An index that does not exist is an outage, not an empty answer.
   */
  public function testTheMissingIndexIsAnOutage(): void {
    $this->expectException(RetrieverException::class);
    $this->retriever(['index' => 'gone'])->retrieve('release');
  }

  /**
   * A hit whose page is gone is dropped rather than cited.
   */
  public function testTheIndexRowWithoutItsPageIsDropped(): void {
    $node = $this->page('Release checklist', 'Cut the tag.', '/handbook/release');
    $node->delete();

    $this->assertSame([], $this->retriever()->retrieve('release'));
  }

  /**
   * The retriever under test.
   *
   * @param array<string, mixed> $overrides
   *   Settings to override.
   */
  private function retriever(array $overrides = []): RetrieverInterface {
    /** @var \Drupal\ai_rag_cite\RetrieverInterface $retriever */
    $retriever = $this->container->get('plugin.manager.ai_rag_cite_retriever')->createInstance(
      'search_api_index',
      $overrides + ['index' => 'pages', 'top_k' => 10, 'meta_field' => '', 'excerpt_field' => 'body'],
    );
    return $retriever;
  }

  /**
   * A published page, aliased and indexed.
   */
  private function page(string $title, string $body, string $alias): NodeInterface {
    $node = $this->createNode([
      'type' => 'page',
      'title' => $title,
      'status' => TRUE,
      'body' => ['value' => $body, 'format' => 'plain_text'],
    ]);
    PathAlias::create(['path' => '/node/' . $node->id(), 'alias' => $alias])->save();
    $this->assertSame(1, Index::load('pages')->indexItems(), 'The page reached the index.');
    return $node;
  }

}
