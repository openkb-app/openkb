<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\openkb_search\Embedding\EmbeddingCacheInterface;

/**
 * What indexing writes into the chunk index, row by row.
 *
 * What is asserted is the row: one per section, carrying the block a citation
 * lands on, the headings it sits under, and the page's attributes — because
 * that row is all the read path ever sees.
 *
 * @group openkb_search
 */
final class ComarkSectionsTest extends ChunkIndexTestBase {

  /**
   * One row per section, each naming its block and the headings above it.
   */
  public function testOneRowPerSection(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT.\n\n### Keys\n\nRotate them.\n");
    $this->assertSame(1, $this->index->indexItems());

    $rows = $this->rows();
    $this->assertCount(3, $rows, 'The page heading opens a section, and each heading below it one more.');
    // The block a citation lands on is the section's own heading.
    $this->assertSame(['b-1', 'b-3', 'b-5'], array_column($rows, 'block_id'));
    $this->assertSame([
      ['Onboarding'],
      ['Onboarding', 'Accounts'],
      ['Onboarding', 'Accounts', 'Keys'],
    ], array_column($rows, 'heading_path'));
    $this->assertSame([0, 0, 0], array_column($rows, 'part'));

    // Every row carries the page it belongs to, so a hit needs no entity load.
    foreach ($rows as $row) {
      $this->assertSame('Onboarding', $row['title']);
      $this->assertSame('Handbook', $row['space']);
      $this->assertSame('en', $row['langcode']);
      $this->assertNotSame('', $row['path']);
    }
    $this->assertSame("Accounts\n\nAsk IT.", $rows[1]['content'], 'The row holds the section text an excerpt shows.');
  }

  /**
   * A row carries what its own section references, not what the page does.
   */
  public function testEachRowCarriesItsOwnReferences(): void {
    $this->createPage('Onboarding', TRUE, implode("\n", [
      'Read this first.',
      '',
      '## Accounts',
      '',
      'Derived from it. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"}',
      '',
      '## Keys',
      '',
      'See :doc[Release process]{nid="7"} and :citation{url="https://example.org/"}.',
    ]));
    $this->assertSame(1, $this->index->indexItems());

    $rows = $this->rows();
    // The page and the block are both edges, so one term answers either
    // question. An external citation is neither: nothing points back from it.
    $this->assertSame([[], ['42', '42#b-4f2a'], []], array_column($rows, 'cites'));
    $this->assertSame([[], [], ['7']], array_column($rows, 'links'));
  }

  /**
   * Indexing the same page twice leaves one row per section, not two.
   */
  public function testReindexingLeavesOneRowPerSection(): void {
    $node = $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT.\n");
    $this->index->indexItems();
    $before = $this->rows();

    $this->index->trackItemsUpdated('entity:node', [$node->id() . ':en']);
    $this->index->indexItems();

    $this->assertSame(array_column($before, 'drupal_long_id'), array_column($this->rows(), 'drupal_long_id'));
  }

  /**
   * A draft is never embedded, so no query has to keep it from anyone.
   */
  public function testDraftsAreNeverEmbedded(): void {
    $this->createPage('Unpublished', FALSE, "Secret.\n\n## More\n\nAlso secret.\n");
    $this->index->indexItems();

    $this->assertSame([], $this->rows());
  }

  /**
   * The shipped config names `chunks` as the field that is embedded.
   *
   * Which field carries the sections is the index's config and nothing else —
   * the strategy reads whatever is marked Main Content. So the setting is what
   * has to be held: a YAML change dropping it takes this case red, rather than
   * leaving an index that embeds nothing while search_api counts every item as
   * indexed.
   */
  public function testTheShippedConfigNamesChunksAsMainContent(): void {
    $shipped = $this->recipeConfig('ai_search.index.kb_chunks');
    $this->assertSame('main_content', $shipped['indexing_options']['chunks']['indexing_option'] ?? NULL);
    $this->assertSame(
      ['chunks'],
      array_keys(array_filter(
        $shipped['indexing_options'],
        fn (array $option) => ($option['indexing_option'] ?? '') === 'main_content',
      )),
      'One field is embedded, and it is the one the sidecar fills.',
    );

    $this->createPage('Onboarding', TRUE, "Read this first.\n");
    $this->index->indexItems();

    $this->assertNotSame([], $this->rows(), 'The shipped config embeds what it is handed.');
  }

  /**
   * A section already embedded is never sent to the provider again.
   *
   * The provider batches every chunk of an item into one call, so the cache
   * has to answer that shape too or indexing pays for the whole page on every
   * run. A vector nothing but the cache could have produced proves it did.
   */
  public function testCachedSectionsNeverReachTheProvider(): void {
    $cache = $this->container->get(EmbeddingCacheInterface::class);
    $markdown = "Read this first.\n\n## Accounts\n\nAsk IT.\n";
    $cached = array_fill(0, 512, 0.0);
    $cached[0] = 1.0;
    foreach ($this->sidecar("# Onboarding\n\n$markdown")['chunks'] as $chunk) {
      $cache->set('openkb_hash', 'text-embedding-3-small', $this->embedded('Onboarding', $chunk, ['Type: article']), 512, $cached);
    }

    $this->createPage('Onboarding', TRUE, $markdown);
    $this->index->indexItems();

    $vectors = array_column($this->rows(['vector']), 'vector');
    $this->assertCount(2, $vectors);
    foreach ($vectors as $vector) {
      $this->assertSame($cached, $vector);
    }
  }

  /**
   * Every frontmatter field is on the row, in the shape its type asks for.
   */
  public function testTheRowCarriesEveryFrontmatterField(): void {
    $owner = $this->createUser([], 'rosa');
    $contributor = $this->createUser([], 'sam');
    $this->createPage('Onboarding', TRUE, "Read this first.\n", frontmatter: [
      'field_type' => 'runbook',
      'field_tags' => [$this->createTag('on-call')->id(), $this->createTag('handover')->id()],
      'field_summary' => 'How the on-call handover runs.',
      'field_owner' => $owner->id(),
      'field_contributors' => [$contributor->id()],
    ]);
    $this->index->indexItems();

    $row = $this->rows(['type', 'tags', 'summary', 'owner', 'contributors', 'created'])[0];
    $this->assertSame('runbook', $row['type']);
    $this->assertSame(['on-call', 'handover'], $row['tags'], 'A reference is stored as its label.');
    $this->assertSame('How the on-call handover runs.', $row['summary']);
    $this->assertSame('rosa', $row['owner']);
    $this->assertSame('sam', $row['contributors']);
    $this->assertIsInt($row['created'], 'A date is stored as a number, so a range can bound it.');
  }

  /**
   * The summary is analyzed text, so the lexical clause can match a word in it.
   */
  public function testTheSummaryIsMappedAsAnalyzedText(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n");
    $this->index->indexItems();

    $mapping = $this->provider->getClient()->indices()->getMapping(['index' => 'default_' . $this->collection]);
    $properties = $mapping['default_' . $this->collection]['mappings']['properties'];
    $this->assertSame('text', $properties['summary']['type']);
    $this->assertSame('keyword', $properties['type']['type'], 'A filtered attribute stays an exact term.');
  }

  /**
   * A Contextual Content field opens every chunk's embedded text.
   */
  public function testTheContextualFieldOpensEveryEmbeddedText(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT.\n", frontmatter: ['field_type' => 'runbook']);
    $this->index->indexItems();

    $texts = $this->embeddedTexts();
    $this->assertCount(2, $texts);
    foreach ($texts as $text) {
      $this->assertStringStartsWith("Type: runbook\n", $text, 'The label and the value, one line, in front of the heading path.');
    }
  }

  /**
   * The title is a Contextual Content field like the rest, written bare.
   */
  public function testTheTitleIsContextWrittenBare(): void {
    $this->indexRenamedPage();

    $this->assertSame(
      "Onboarding handbook\nType: runbook\nOnboarding > Accounts\nAccounts\n\nAsk IT.",
      $this->embeddedTexts()[1],
      'The title opens the text, bare and in field order.',
    );
  }

  /**
   * A heading path that opens on the page's own heading does not repeat it.
   */
  public function testTheTitleIsNotRepeatedAfterItsOwnHeading(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n", frontmatter: ['field_type' => 'runbook']);
    $this->index->indexItems();

    $this->assertSame("Type: runbook\nOnboarding\nOnboarding\n\nRead this first.", $this->embeddedTexts()[0]);
  }

  /**
   * A title the config does not mark is not embedded, only stored.
   */
  public function testAnUnmarkedTitleIsNotEmbedded(): void {
    $this->config('ai_search.index.kb_chunks')
      ->set('indexing_options.title.indexing_option', 'attributes')
      ->save();
    $this->indexRenamedPage();

    $this->assertSame("Type: runbook\nOnboarding > Accounts\nAccounts\n\nAsk IT.", $this->embeddedTexts()[1]);
    $this->assertSame('Onboarding handbook', $this->rows(['title'])[0]['title'], 'The attribute a row names its page by is there either way.');
  }

  /**
   * Indexes a page whose first heading is not its title.
   *
   * The two are the same on a page a write created, and then the heading path
   * carries the title already — so only a renamed one shows what the title
   * line does.
   */
  private function indexRenamedPage(): void {
    $node = $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT.\n", frontmatter: ['field_type' => 'runbook']);
    $node->setTitle('Onboarding handbook')->save();
    $this->index->indexItems();
  }

  /**
   * A multi-value Contextual Content field lists each of its values once.
   */
  public function testMultiValueContextListsEveryValueOnce(): void {
    $this->config('ai_search.index.kb_chunks')
      ->set('indexing_options.tags.indexing_option', 'contextual_content')
      ->save();

    $this->createPage('Onboarding', TRUE, "Read this first.\n", frontmatter: [
      'field_tags' => [$this->createTag('on-call')->id(), $this->createTag('handover')->id()],
    ]);
    $this->index->indexItems();

    $this->assertStringContainsString("Tags: on-call, handover\n", $this->embeddedTexts()[0]);
  }

  /**
   * A field the config does not mark is not embedded, only stored.
   */
  public function testAnUnmarkedFieldIsNotEmbedded(): void {
    $this->config('ai_search.index.kb_chunks')
      ->set('indexing_options.type.indexing_option', 'attributes')
      ->save();

    $this->createPage('Onboarding', TRUE, "Read this first.\n", frontmatter: ['field_type' => 'runbook']);
    $this->index->indexItems();

    $this->assertStringStartsWith('Onboarding', $this->embeddedTexts()[0]);
    $this->assertSame('runbook', $this->rows(['type'])[0]['type'], 'The attribute the filter reads is there either way.');
  }

  /**
   * A page that leaves the field empty embeds no label with nothing after it.
   */
  public function testAnEmptyContextualFieldAddsNoLine(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n", frontmatter: ['field_type' => NULL]);
    $this->index->indexItems();

    $this->assertStringStartsWith('Onboarding', $this->embeddedTexts()[0]);
  }

  /**
   * A provider that is down leaves the page queued, not silently empty.
   *
   * The provider's exception is caught and only logged by ai_search, and the
   * old rows are already deleted by the time the strategy is called. Without a
   * failure of its own the page would count as indexed and answer no query,
   * with nothing saying so. Failing keeps it in the queue, so the next run
   * repairs it.
   */
  public function testProviderFailureLeavesTheItemQueued(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT.\n");
    $this->index->indexItems();
    $indexed = $this->rows();
    $this->assertCount(2, $indexed);

    // A page nothing has embedded yet, so the cache cannot answer for it.
    $this->config('openkb_search_test.settings')->set('embeddings_fail', TRUE)->save();
    $this->createPage('Keys', TRUE, "Rotate them.\n");

    $this->assertSame(0, $this->index->indexItems(), 'Nothing counts as indexed.');
    $this->assertSame(1, $this->index->getTrackerInstance()->getRemainingItemsCount(), 'The page is still queued.');
    $this->assertSame(
      array_column($indexed, 'drupal_long_id'),
      array_column($this->rows(), 'drupal_long_id'),
      'The page that did index keeps its rows.',
    );

    $this->config('openkb_search_test.settings')->set('embeddings_fail', FALSE)->save();
    $this->assertSame(1, $this->index->indexItems());
    $this->assertCount(3, $this->rows(), 'The next run writes the rows the failed one owed.');
  }

}
