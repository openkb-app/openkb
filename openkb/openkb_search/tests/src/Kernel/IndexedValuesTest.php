<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;

/**
 * The index has to hold titles and text as they were written.
 *
 * A row is what a hit is built from — the search page, the chat's citations
 * and the picker all read it without loading the page behind it — so matching
 * is the analyzer's job and never a processor's rewrite.
 *
 * @group openkb_search
 */
final class IndexedValuesTest extends ChunkIndexTestBase {

  /**
   * The read path under test.
   */
  private ChunkRetrievalInterface $retrieval;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->retrieval = $this->container->get(ChunkRetrievalInterface::class);
  }

  /**
   * The row carries the page's title, not a reduction of it.
   */
  public function testTheTitleIsIndexedAsWritten(): void {
    $node = $this->createPage('Release Checklist', TRUE, "Qwertzuiop lives here.\n");

    $this->indexPages();

    $this->assertSame([$node->label()], array_unique(array_column($this->rows(['title']), 'title')));
  }

  /**
   * The section text reaches the row readable, as prose and not as markup.
   *
   * A lead section opens on the page's own heading, so the row holds that
   * line and the prose under it, spelled as they were written.
   */
  public function testTheBodyIsIndexedAsWritten(): void {
    $this->createPage('Body Verbatim', TRUE, "The Release Checklist is Reviewed weekly.\n");

    $this->indexPages();

    $this->assertSame(
      ["Body Verbatim\n\nThe Release Checklist is Reviewed weekly."],
      array_column($this->rows(['content']), 'content'),
    );
  }

  /**
   * Case is the analyzer's business: a lower-case query finds a capital title.
   */
  public function testLowerCaseQueryFindsCapitalisedTitle(): void {
    $this->createPage('Release Checklist', TRUE, "Qwertzuiop lives here.\n");

    $this->indexPages();

    $this->assertSame(['Release Checklist'], $this->lexicalTitles('release checklist'));
  }

  /**
   * Accents fold both ways, so neither spelling hides the page.
   */
  public function testAnAccentedWordIsFoundWithAndWithoutTheAccent(): void {
    $this->createPage('Über Uns', TRUE, "Ein élève notiert mit.\n");

    $this->indexPages();

    $this->assertSame(['Über Uns'], $this->lexicalTitles('über'));
    $this->assertSame(['Über Uns'], $this->lexicalTitles('Uber'));
    $this->assertSame(['Über Uns'], $this->lexicalTitles('élève'));
    $this->assertSame(['Über Uns'], $this->lexicalTitles('eleve'));
  }

  /**
   * The pages a query reaches through the lexical arm alone.
   *
   * The floor shuts the vector clause, so what answers can only have come
   * from the analyzed text.
   *
   * @return list<string>
   *   The titles, best first.
   */
  private function lexicalTitles(string $query): array {
    $this->setRelevanceFloor(1.0);
    $window = $this->retrieval->retrievePages($query, 10);
    return array_map(static fn ($page) => $page->best()->title, $window->pages);
  }

}
