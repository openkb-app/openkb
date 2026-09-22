<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\openkb_search\Retrieval\ChunkHit;
use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Drupal\openkb_search\Retrieval\PageHit;
use Drupal\openkb_search_test\Hook\LoadCounter;
use Drupal\openkb_search_test\Plugin\AiProvider\HashEmbeddingProvider;
use Drupal\search_api\SearchApiException;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * What the read path answers, against rows the shipped strategy wrote.
 *
 * The one query both AI consumers run: sections out of the live chunk index,
 * scoped to the account, built from the row and nothing else.
 *
 * @group openkb_search
 */
final class ChunkRetrievalTest extends ChunkIndexTestBase {

  /**
   * The read path under test.
   */
  private ChunkRetrievalInterface $retrieval;

  /**
   * On the Alpha roster only.
   */
  private UserInterface $alphaReader;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->retrieval = $this->container->get(ChunkRetrievalInterface::class);
    $this->alphaReader = $this->createUser(['access content']);
  }

  /**
   * A hit carries the row, and names the block the citation lands on.
   */
  public function testTheHitIsBuiltFromTheRow(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT before the first day.\n");
    $this->createPage('Release checklist', TRUE, "Tag the release.\n");
    $this->indexPages();

    $hits = $this->retrieval->retrieve('Ask IT before the first day.', 10);
    $this->assertNotSame([], $hits);
    $hit = $this->hitOf($hits, 'Accounts');

    $this->assertInstanceOf(ChunkHit::class, $hit);
    $this->assertSame('Onboarding', $hit->title);
    $this->assertSame('Handbook', $hit->space);
    $this->assertSame('en', $hit->langcode);
    $this->assertSame(0, $hit->part);
    $this->assertStringContainsString('Ask IT before the first day.', $hit->excerpt);
    $this->assertSame(['Onboarding', 'Accounts'], $hit->headingPath);
    $this->assertSame('Onboarding › Accounts', $hit->headingLine());
    $this->assertSame('b-3', $hit->blockId);
    $this->assertSame($hit->path . '#b-3', $hit->anchoredPath());
    $this->assertMatchesRegularExpression('#^entity:node/\d+:en$#', $hit->entityId);
  }

  /**
   * A hit on the page's lead section names the title heading's block.
   *
   * That section opens on the heading the page renders as its own `<h1>`, so
   * the citation anchors there like any other.
   */
  public function testTheLeadSectionHitNamesTheTitleBlock(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT before the first day.\n");
    $this->indexPages();

    $hit = $this->hitOf($this->retrieval->retrieve('Read this first.', 10), 'Onboarding');
    $this->assertInstanceOf(ChunkHit::class, $hit);
    $this->assertSame(['Onboarding'], $hit->headingPath);
    $this->assertSame('b-1', $hit->blockId);
    $this->assertSame($hit->path . '#b-1', $hit->anchoredPath());
  }

  /**
   * A body no write has spelled an id into cites the page, not a block.
   *
   * Every write mints the title heading's id, so this is markdown that
   * reached the field some other way.
   */
  public function testTheLeadSectionWithNoBlockIdCitesThePage(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n", NULL, FALSE);
    $this->indexPages();

    $hit = $this->hitOf($this->retrieval->retrieve('Read this first.', 10), 'Onboarding');
    $this->assertInstanceOf(ChunkHit::class, $hit);
    $this->assertSame('', $hit->blockId);
    $this->assertSame($hit->path, $hit->anchoredPath());
  }

  /**
   * The best hit is the section the query shares its words with.
   *
   * Every environment without an OpenAI key embeds through
   * `openkb_search_test`'s bag-of-words provider, and this is what ranking
   * means there: an e2e that searches for a page it just wrote finds it.
   */
  public function testTheBestHitSharesTheQuerysWords(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT before the first day.\n");
    $this->createPage('Release checklist', TRUE, "Tag the release, then announce it.\n");
    $this->indexPages();

    $hits = $this->retrieval->retrieve('tag the release', 5);
    $this->assertNotSame([], $hits);
    $this->assertSame('Release checklist', $hits[0]->title);
  }

  /**
   * Retrieval loads no page: everything a hit shows travels in the row.
   */
  public function testRetrievalLoadsNoEntity(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT.\n");
    $this->indexPages();

    // The pages were created in this request, so they sit in the entity
    // memory cache and a load would answer from there without the hook ever
    // firing — which would make this case pass on a read path that loads.
    $this->container->get('entity_type.manager')->getStorage('node')->resetCache();
    $state = $this->container->get('state');
    LoadCounter::reset($state);
    $hits = $this->retrieval->retrieve('Ask IT.', 10);

    $this->assertNotSame([], $hits);
    $this->assertSame(0, LoadCounter::loads($state, 'node'));
  }

  /**
   * A query already asked is embedded once, at the collection's dimension.
   *
   * Left to ai_search the query is embedded with no dimension named, so the
   * vector would be the model's widest and the cache would key it under none
   * of them.
   */
  public function testTheQueryIsEmbeddedOnceAtTheServersDimension(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n");
    $this->indexPages();

    $state = $this->container->get('state');
    $state->set(HashEmbeddingProvider::CALLS_STATE_KEY, 0);
    $this->retrieval->retrieve('how do I get an account', 5);
    $this->assertSame(1, $state->get(HashEmbeddingProvider::CALLS_STATE_KEY));

    $this->retrieval->retrieve('how do I get an account', 5);
    $this->assertSame(1, $state->get(HashEmbeddingProvider::CALLS_STATE_KEY), 'The second query is answered from the cache.');

    $cached = $this->container->get('openkb_search.embedding_cache')
      ->get('openkb_hash', 'text-embedding-3-small', 'how do I get an account', 512);
    $this->assertNotNull($cached, 'The query is keyed by the dimension the collection holds.');
    $this->assertCount(512, $cached);
  }

  /**
   * A provider that cannot answer is unavailability, not an empty result.
   *
   * The embedding happens in our code now, so the exception would escape a
   * consumer that only watches for a Search API failure — and the chat would
   * report no sources where the truth is that retrieval never ran.
   */
  public function testProviderThatCannotAnswerIsUnavailability(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n");
    $this->indexPages();
    $this->config('openkb_search_test.settings')->set('embeddings_fail', TRUE)->save();

    $this->expectException(SearchApiException::class);
    $this->retrieval->retrieve('Read this first.', 5);
  }

  /**
   * A page of a space the account is not on is never retrieved.
   *
   * `space_access_filter` scopes the query, and it is the only thing that
   * does: the query itself bypasses entity access so nothing is loaded.
   */
  public function testForeignSpaceIsUnreachable(): void {
    $alpha = $this->createSpace('Alpha', $this->alphaReader);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Alpha handbook', TRUE, "Qwertzuiop lives here.\n", $alpha);
    $this->createPage('Beta handbook', TRUE, "Qwertzuiop lives here.\n", $beta);
    $this->indexPages();

    $this->setCurrentUser($this->alphaReader);
    $this->assertSame(['Alpha handbook'], $this->titles($this->retrieval->retrieve('Qwertzuiop lives here.', 10)));

    $this->setCurrentUser(User::getAnonymousUser());
    $this->assertSame([], $this->retrieval->retrieve('Qwertzuiop lives here.', 10));
  }

  /**
   * One space's sections, where the caller asks for that space only.
   */
  public function testTheSpaceOptionNarrowsToOneSpace(): void {
    $alpha = $this->createSpace('Alpha', $this->alphaReader);
    $this->createPage('Alpha handbook', TRUE, "Qwertzuiop lives here.\n", $alpha);
    $this->createPage('Handbook page', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $this->assertSame(
      ['Alpha handbook'],
      $this->titles($this->retrieval->retrieve('Qwertzuiop lives here.', 10, ['space' => 'Alpha'])),
    );
  }

  /**
   * One document type's sections, where the caller asks for that type only.
   *
   * Both reads narrow alike: the tool retrieves sections, the search page
   * collapses them to rows, and neither may answer what the other would not.
   */
  public function testTheTypeOptionNarrowsToOneType(): void {
    $this->createPage('Deploy runbook', TRUE, "Qwertzuiop lives here.\n", frontmatter: ['field_type' => 'runbook']);
    $this->createPage('Handbook page', TRUE, "Qwertzuiop lives here.\n", frontmatter: ['field_type' => 'article']);
    $this->indexPages();

    $options = ['type' => 'runbook'];
    $this->assertSame(
      ['Deploy runbook'],
      $this->titles($this->retrieval->retrieve('Qwertzuiop lives here.', 10, $options)),
    );
    $this->assertSame(
      ['Deploy runbook'],
      array_map(
        static fn (PageHit $page) => $page->best()->title,
        $this->retrieval->retrievePages('Qwertzuiop lives here.', 10, $options)->pages,
      ),
    );
  }

  /**
   * The type narrows within the caller's spaces, never past them.
   */
  public function testTheTypeNarrowsInsideTheAccessFilter(): void {
    $alpha = $this->createSpace('Alpha', $this->alphaReader);
    $this->createPage('Alpha runbook', TRUE, "Qwertzuiop lives here.\n", $alpha, frontmatter: ['field_type' => 'runbook']);
    $this->createPage('Handbook runbook', TRUE, "Qwertzuiop lives here.\n", frontmatter: ['field_type' => 'runbook']);
    $this->indexPages();

    $this->setCurrentUser($this->createUser(['access content']));
    $this->assertSame([], $this->titles($this->retrieval->retrieve('Qwertzuiop lives here.', 10, ['type' => 'runbook'])));
  }

  /**
   * A hit names the type and the tags its page carries.
   */
  public function testTheHitNamesTheTypeAndTags(): void {
    $this->createPage('Deploy runbook', TRUE, "Qwertzuiop lives here.\n", frontmatter: [
      'field_type' => 'runbook',
      'field_tags' => [$this->createTag('on-call')->id()],
    ]);
    $this->indexPages();

    $hit = $this->retrieval->retrieve('Qwertzuiop lives here.', 10)[0];
    $this->assertSame('runbook', $hit->type);
    $this->assertSame(['on-call'], $hit->tags);
  }

  /**
   * One author's sections, where the caller asks for that author only.
   */
  public function testTheOwnerOptionNarrowsToOneAuthor(): void {
    $rosa = $this->createUser([], 'rosa');
    $this->createPage('Rosa handbook', TRUE, "Qwertzuiop lives here.\n", frontmatter: ['field_owner' => $rosa->id()]);
    $this->createPage('Unowned page', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $this->assertSame(
      ['Rosa handbook'],
      $this->titles($this->retrieval->retrieve('Qwertzuiop lives here.', 10, ['owner' => 'rosa'])),
    );
  }

  /**
   * A date option bounds the rows below it, not to one exact moment.
   */
  public function testTheDateOptionNarrowsToTheRowsAtOrAfterIt(): void {
    $old = $this->createPage('Old handbook', TRUE, "Qwertzuiop lives here.\n");
    $this->createPage('New handbook', TRUE, "Qwertzuiop lives here.\n");
    $now = $this->container->get('datetime.time')->getRequestTime();
    $old->set('changed', $now - 90 * 86400)->save();
    $this->indexPages();

    $this->assertSame(
      ['New handbook'],
      $this->titles($this->retrieval->retrieve('Qwertzuiop lives here.', 10, ['changed' => $now - 7 * 86400])),
    );
  }

  /**
   * The reverse lookup: what builds on a block, and what points at a page.
   */
  public function testTheReferenceOptionsAnswerWhatPointsAtSomething(): void {
    $this->createPage('Derived page', TRUE, "Qwertzuiop lives here. :citation{nid=\"42\" block=\"b-4f2a\" v=\"aaaaaaaaaaaa\"}\n");
    $this->createPage('Linking page', TRUE, "Qwertzuiop lives here. :doc[Release process]{nid=\"42\"}\n");
    $this->createPage('Unrelated page', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $query = 'Qwertzuiop lives here.';
    $this->assertSame(['Derived page'], $this->titles($this->retrieval->retrieve($query, 10, ['cites' => '42#b-4f2a'])));
    $this->assertSame(['Derived page'], $this->titles($this->retrieval->retrieve($query, 10, ['cites' => '42'])));
    $this->assertSame(['Linking page'], $this->titles($this->retrieval->retrieve($query, 10, ['links' => '42'])));
  }

  /**
   * A hit carries what its own section cites, so an answer can chain on.
   */
  public function testTheHitNamesWhatTheSectionCites(): void {
    $this->createPage('Derived page', TRUE, "Qwertzuiop lives here. :citation{nid=\"42\" block=\"b-4f2a\" v=\"aaaaaaaaaaaa\"}\n");
    $this->indexPages();

    $hit = $this->retrieval->retrieve('Qwertzuiop lives here.', 10)[0];
    $this->assertSame(['42', '42#b-4f2a'], $hit->cites);
  }

  /**
   * An option naming no attribute is a mistake, not a narrowing that misses.
   */
  public function testAnOptionNamingNoAttributeIsRefused(): void {
    $this->expectException(\InvalidArgumentException::class);
    $this->retrieval->retrieve('Qwertzuiop lives here.', 10, ['typ' => 'runbook']);
  }

  /**
   * A page is ranked by its best section, and keeps the others beside it.
   */
  public function testTheCollapseRanksPagesByTheirBestSection(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop opens the page.\n\n## Accounts\n\nQwertzuiop again, and more words that do not match.\n");
    $this->createPage('Release checklist', TRUE, "Tag the release.\n");
    $this->indexPages();

    $pages = $this->pagesOf('Qwertzuiop opens the page.', 10);

    $this->assertNotSame([], $pages);
    $page = $pages[0];
    $this->assertInstanceOf(PageHit::class, $page);
    $this->assertSame('Onboarding', $page->best()->title);
    $this->assertSame($page->best()->score, $page->score());
    // Every section of the page travels with it, best first.
    $this->assertGreaterThan(1, count($page->sections));
    $scores = array_map(static fn (ChunkHit $section) => $section->score, $page->sections);
    $sorted = $scores;
    rsort($sorted);
    $this->assertSame($sorted, $scores);
  }

  /**
   * One page is one row, however many of its sections matched.
   */
  public function testTheCollapseAnswersOneRowPerPage(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop opens the page.\n\n## Accounts\n\nQwertzuiop again.\n\n## Laptops\n\nQwertzuiop once more.\n");
    $this->indexPages();

    $pages = $this->pagesOf('Qwertzuiop', 10);

    $this->assertCount(1, $pages);
    $this->assertGreaterThan(1, count($pages[0]->sections));
    // And every section names the same page.
    foreach ($pages[0]->sections as $section) {
      $this->assertSame($pages[0]->best()->entityId, $section->entityId);
    }
  }

  /**
   * Every section of a page anchors on the block it opens on.
   */
  public function testEveryCollapsedSectionAnchorsOnItsOwnBlock(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop opens the page.\n\n## Accounts\n\nQwertzuiop again.\n");
    $this->indexPages();

    $pages = $this->pagesOf('Qwertzuiop', 10);
    $this->assertNotSame([], $pages);

    $anchors = array_map(
      static fn (ChunkHit $section) => $section->anchoredPath(),
      $pages[0]->sections,
    );
    $this->assertSame($anchors, array_unique($anchors), 'Each section lands on a block of its own.');
    foreach ($anchors as $anchor) {
      $this->assertStringStartsWith($pages[0]->best()->path . '#', $anchor);
    }
  }

  /**
   * A page of a space the account is not on is never a row.
   */
  public function testTheCollapseNeverAnswersForeignSpaces(): void {
    $alpha = $this->createSpace('Alpha', $this->alphaReader);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Alpha handbook', TRUE, "Qwertzuiop lives here.\n", $alpha);
    $this->createPage('Beta handbook', TRUE, "Qwertzuiop lives here.\n", $beta);
    $this->indexPages();

    $this->setCurrentUser($this->alphaReader);
    $pages = $this->pagesOf('Qwertzuiop lives here.', 10);
    $this->assertSame(['Alpha handbook'], array_map(
      static fn (PageHit $page) => $page->best()->title,
      $pages,
    ));
  }

  /**
   * A collapsed row loads no page either.
   */
  public function testTheCollapseLoadsNoEntity(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT.\n");
    $this->indexPages();

    $this->container->get('entity_type.manager')->getStorage('node')->resetCache();
    $state = $this->container->get('state');
    LoadCounter::reset($state);
    $pages = $this->pagesOf('Ask IT.', 10);

    $this->assertNotSame([], $pages);
    $this->assertSame(0, LoadCounter::loads($state, 'node'));
  }

  /**
   * A query under the query's floor answers no page at all.
   *
   * The search page inherits the floor the chat and the tool run under: no
   * row is "the nearest thing we have", so the page can say nothing matches.
   * The question shares no word with the page, so only the vector clause can
   * answer it and the floor is what decides.
   */
  public function testQueriesUnderTheFloorAnswerNoPage(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();
    $this->assertNotSame([], $this->pagesOf('Asdfghjkl', 10));

    // The highest score the metric can answer, which these fixtures do not
    // reach.
    $this->setRelevanceFloor(1.0);
    $this->assertSame([], $this->pagesOf('Asdfghjkl', 10));
  }

  /**
   * The parts of one split block are one section, on one anchor.
   *
   * An oversized block is chunked into parts that share a block id. They are
   * the same section of the page and reached by the same anchor, so the row
   * lists them once.
   */
  public function testTheCollapseKeepsOneSectionPerBlock(): void {
    $long = trim(str_repeat("Qwertzuiop lives in this paragraph.\n\n", 30));
    $this->createPage('Onboarding', TRUE, "## Accounts\n\n$long\n");
    $this->indexPages();

    $parts = array_filter(
      $this->retrieval->retrieve('Qwertzuiop lives in this paragraph.', 20),
      static fn (ChunkHit $hit) => $hit->headingPath === ['Onboarding', 'Accounts'],
    );
    $this->assertGreaterThan(1, count($parts), 'The block was chunked into parts.');
    $this->assertCount(1, array_unique(array_map(static fn (ChunkHit $hit) => $hit->blockId, $parts)));

    $pages = $this->pagesOf('Qwertzuiop lives in this paragraph.', 20);
    $this->assertCount(1, $pages);
    $blocks = array_map(static fn (ChunkHit $section) => $section->blockId, $pages[0]->sections);
    $this->assertSame($blocks, array_unique($blocks), 'One section per block.');
  }

  /**
   * A page carries the row's change date, which no entity was loaded for.
   */
  public function testThePageCarriesTheChangeDateFromTheRow(): void {
    $node = $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $pages = $this->pagesOf('Qwertzuiop lives here.', 10);
    $this->assertNotSame([], $pages);
    $this->assertSame((int) $node->getChangedTime(), $pages[0]->best()->changed);
  }

  /**
   * The pages one collapse answered.
   *
   * @param string $query
   *   The query to run.
   * @param int $topK
   *   How many chunks to fetch.
   *
   * @return list<\Drupal\openkb_search\Retrieval\PageHit>
   *   The pages, best first.
   */
  private function pagesOf(string $query, int $topK): array {
    return $this->retrieval->retrievePages($query, $topK)->pages;
  }

  /**
   * The hit whose heading path ends on one heading.
   *
   * @param \Drupal\openkb_search\Retrieval\ChunkHit[] $hits
   *   The hits.
   * @param string $heading
   *   The heading the section sits under.
   */
  private function hitOf(array $hits, string $heading): ?ChunkHit {
    foreach ($hits as $hit) {
      $path = $hit->headingPath;
      if (array_pop($path) === $heading) {
        return $hit;
      }
    }
    return NULL;
  }

  /**
   * The page titles of the hits, without repeating one.
   *
   * @param \Drupal\openkb_search\Retrieval\ChunkHit[] $hits
   *   The hits.
   *
   * @return list<string>
   *   The titles.
   */
  private function titles(array $hits): array {
    return array_values(array_unique(array_map(fn (ChunkHit $hit) => $hit->title, $hits)));
  }

}
