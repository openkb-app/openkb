<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\openkb_search\Controller\SearchController;
use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * What `GET /openkb/search` answers, against the live chunk index.
 *
 * The search page's whole read: one row per page, the sections it matched
 * beside it, and a window the page can walk.
 *
 * @group openkb_search
 */
final class SearchControllerTest extends ChunkIndexTestBase {

  /**
   * The chunks the controller's first fetch of window 0 asks the index for.
   *
   * One page past the window, six chunks each, as the controller's own
   * PAGE_SIZE and CHUNKS_PER_PAGE make it.
   */
  private const FIRST_FETCH = 66;

  /**
   * The controller under test.
   */
  private SearchController $controller;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->controller = SearchController::create($this->container);
  }

  /**
   * A row is a page, opened on its best section, with the rest beside it.
   */
  public function testRowsArePagesWithTheirMatchingSections(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop opens the page.\n\n## Accounts\n\nQwertzuiop again.\n");
    $this->indexPages();

    $body = $this->search('Qwertzuiop');

    $this->assertSame('Qwertzuiop', $body['query']);
    $this->assertSame(0, $body['page']);
    $this->assertCount(1, $body['pages']);

    $page = $body['pages'][0];
    $this->assertSame('Onboarding', $page['title']);
    $this->assertSame('Handbook', $page['space']);
    $this->assertGreaterThan(0, $page['changed']);
    $this->assertGreaterThan(1, count($page['sections']));
    $this->assertSame($page['sections'][0]['score'], $page['score']);

    $section = $page['sections'][0];
    $this->assertSame($page['path'] . '#' . $section['block_id'], $section['path']);
    $this->assertNotSame('', $section['excerpt']);
    $this->assertNotSame([], $section['heading_path']);
  }

  /**
   * The excerpt is the section's prose, not the heading beside it.
   */
  public function testTheExcerptLeavesOutTheHeadingTheRowNames(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop opens the page.\n\n## Accounts\n\nQwertzuiop again.\n");
    $this->indexPages();

    $excerpts = [];
    foreach ($this->search('Qwertzuiop')['pages'][0]['sections'] as $section) {
      $excerpts[implode(' > ', $section['heading_path'])] = $section['excerpt'];
    }
    $this->assertSame('Qwertzuiop again.', $excerpts['Onboarding > Accounts']);
    $this->assertSame('Qwertzuiop opens the page.', $excerpts['Onboarding']);
  }

  /**
   * A later part of a split block opens mid-section and keeps its first line.
   */
  public function testTheLaterPartOfSplitBlockKeepsItsOpeningLine(): void {
    $long = trim(str_repeat("Accounts are handled by Qwertzuiop.\n\n", 30));
    $this->createPage('Onboarding', TRUE, "## Accounts\n\n$long\n");
    $this->indexPages();

    foreach ($this->retrieval()->retrieve('Accounts are handled by Qwertzuiop.', 20) as $hit) {
      if ($hit->part > 0) {
        $this->assertSame($hit->excerpt, $hit->prose());
        return;
      }
    }
    $this->fail('The oversized block was never chunked into parts.');
  }

  /**
   * A further window is announced, and the last one is not.
   */
  public function testTheAnswerSaysWhetherFurtherWindowFollows(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->createPage('Release checklist', TRUE, "Qwertzuiop lives here too.\n");
    $this->indexPages();

    $body = $this->search('Qwertzuiop lives here.');

    $this->assertCount(2, $body['pages']);
    $this->assertFalse($body['has_more']);
    // A search knows the window it fetched and no more: the collapse runs
    // after the chunk fetch, so nothing counts the pages behind it.
    $this->assertNull($body['total']);
  }

  /**
   * A window past the pages there are is empty, and says so.
   */
  public function testWindowsPastTheEndAreEmpty(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $body = $this->search('Qwertzuiop lives here.', '1');

    $this->assertSame(1, $body['page']);
    $this->assertSame([], $body['pages']);
    $this->assertFalse($body['has_more']);
  }

  /**
   * An empty query is not a search, and embeds nothing to answer.
   *
   * What it lists is {@see SearchListingTest}; what matters here is that no
   * provider call is made for it.
   */
  public function testEmptyQueriesEmbedNothing(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();
    $embedded = $this->embeddedTexts();
    // The recorder answers what indexing embedded, so an unchanged list below
    // is the read embedding nothing rather than the recorder seeing nothing.
    $this->assertNotSame([], $embedded);

    $body = $this->search('');

    $this->assertSame('', $body['query']);
    $this->assertSame($embedded, $this->embeddedTexts());
  }

  /**
   * A page of a space the account is not on is never a row.
   */
  public function testForeignSpacesAreNeverAnswered(): void {
    $reader = $this->createUser(['access content']);
    $alpha = $this->createSpace('Alpha', $reader);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Alpha handbook', TRUE, "Qwertzuiop lives here.\n", $alpha);
    $this->createPage('Beta handbook', TRUE, "Qwertzuiop lives here.\n", $beta);
    $this->indexPages();

    $this->setCurrentUser($reader);
    $titles = array_column($this->search('Qwertzuiop lives here.')['pages'], 'title');
    $this->assertSame(['Alpha handbook'], $titles);
  }

  /**
   * The `space` parameter is the slug the URL carries, not the label.
   */
  public function testTheSpaceParameterTakesTheSlug(): void {
    $reader = $this->createUser(['access content']);
    $alpha = $this->createSpace('Alpha Space', $reader);
    $this->createPage('Alpha handbook', TRUE, "Qwertzuiop lives here.\n", $alpha);
    $this->createPage('Handbook page', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $this->assertSame('alpha-space', $alpha->getSlug());
    $titles = array_column($this->search('Qwertzuiop lives here.', '0', 'alpha-space')['pages'], 'title');
    $this->assertSame(['Alpha handbook'], $titles);
  }

  /**
   * The `type` parameter narrows the rows, and every row names its type.
   */
  public function testTheTypeParameterNarrowsTheRows(): void {
    $this->createPage('Deploy runbook', TRUE, "Qwertzuiop lives here.\n", frontmatter: [
      'field_type' => 'runbook',
      'field_tags' => [$this->createTag('on-call')->id()],
    ]);
    $this->createPage('Handbook page', TRUE, "Qwertzuiop lives here.\n", frontmatter: ['field_type' => 'article']);
    $this->indexPages();

    // Two pages saying the same thing score alike, so only the set is fixed.
    $titles = array_column($this->search('Qwertzuiop lives here.')['pages'], 'title');
    sort($titles);
    $this->assertSame(['Deploy runbook', 'Handbook page'], $titles);

    $rows = $this->search('Qwertzuiop lives here.', '0', '', 'runbook')['pages'];
    $this->assertSame(['Deploy runbook'], array_column($rows, 'title'));
    $this->assertSame('runbook', $rows[0]['type']);
    $this->assertSame(['on-call'], $rows[0]['tags']);
  }

  /**
   * The type is kept across the windows of one search.
   */
  public function testTheTypeIsKeptOnTheNextWindow(): void {
    $this->createPage('Deploy runbook', TRUE, "Qwertzuiop lives here.\n", frontmatter: ['field_type' => 'runbook']);
    $this->createPage('Handbook page', TRUE, "Qwertzuiop lives here.\n", frontmatter: ['field_type' => 'article']);
    $this->indexPages();

    $body = $this->search('Qwertzuiop lives here.', '1', '', 'runbook');

    $this->assertSame(1, $body['page']);
    $this->assertSame([], $body['pages'], 'One row does not fill a second window.');
    $this->assertFalse($body['has_more']);
  }

  /**
   * A type the frontmatter schema does not list is refused.
   */
  public function testAnUnknownTypeIsRefused(): void {
    $this->expectException(UnprocessableEntityHttpException::class);
    $this->search('Qwertzuiop', '0', '', 'no-such-type');
  }

  /**
   * The author parameter narrows the rows to one person's pages.
   */
  public function testTheAuthorParameterNarrowsTheRows(): void {
    $rosa = $this->createUser([], 'rosa');
    $this->createPage('Rosa handbook', TRUE, "Qwertzuiop lives here.\n", frontmatter: ['field_owner' => $rosa->id()]);
    $this->createPage('Unowned page', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $rows = $this->search('Qwertzuiop lives here.', author: 'rosa')['pages'];
    $this->assertSame(['Rosa handbook'], array_column($rows, 'title'));
  }

  /**
   * A name nobody holds narrows to nothing, the way an unknown slug does.
   */
  public function testTheAuthorNamingNobodyAnswersNoPage(): void {
    $this->createPage('Handbook page', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $this->assertSame([], $this->search('Qwertzuiop lives here.', author: 'nobody')['pages']);
  }

  /**
   * The update range narrows the rows to the pages changed inside it.
   */
  public function testTheUpdatedParameterNarrowsToTheRecentlyChanged(): void {
    $old = $this->createPage('Old handbook', TRUE, "Qwertzuiop lives here.\n");
    $this->createPage('New handbook', TRUE, "Qwertzuiop lives here.\n");
    $old->set('changed', $this->container->get('datetime.time')->getRequestTime() - 90 * 86400)->save();
    $this->indexPages();

    $rows = $this->search('Qwertzuiop lives here.', updated: 'week')['pages'];
    $this->assertSame(['New handbook'], array_column($rows, 'title'));
  }

  /**
   * A range the chip could not have offered is refused.
   */
  public function testAnUnknownUpdateRangeIsRefused(): void {
    $this->expectException(UnprocessableEntityHttpException::class);
    $this->search('Qwertzuiop', updated: 'decade');
  }

  /**
   * A slug naming no space narrows to nothing, not to everything.
   */
  public function testTheSlugNamingNoSpaceAnswersNoPage(): void {
    $this->createPage('Handbook page', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $body = $this->search('Qwertzuiop lives here.', '0', 'no-such-space');

    $this->assertSame([], $body['pages']);
  }

  /**
   * A window that too few pages filled is refetched wider.
   *
   * How many chunks a page matches with is not known before the fetch. Here
   * every section of a handful of pages matches, so the first fetch is spent
   * on them and the page matching with one section only sits past its end.
   */
  public function testTheWindowTooFewPagesFilledIsRefetchedWider(): void {
    $sections = '';
    foreach (range(1, 9) as $section) {
      $sections .= "## Section $section\n\nQwertzuiop lives here.\n\n";
    }
    foreach (range(1, 8) as $page) {
      $this->createPage("Handbook $page", TRUE, $sections);
    }
    // One matching section, diluted so it scores under every section above.
    $this->createPage('Footnote', TRUE, "## Aside\n\nQwertzuiop lives here, among asparagus bicycles cobblestones dandelions elephants furnaces glaciers harmonicas ironmongers jackhammers kaleidoscopes lighthouses mandolins nightingales obelisks periscopes quicksilver rhododendrons sarsaparilla tambourines.\n");
    $this->indexPages();

    $narrow = $this->retrieval()->retrievePages('Qwertzuiop lives here.', self::FIRST_FETCH);
    $this->assertSame(self::FIRST_FETCH, $narrow->chunks, 'the first fetch is full, so a wider one can still answer more');
    $titles = array_map(static fn ($hit) => $hit->best()->title, $narrow->pages);
    $this->assertNotContains('Footnote', $titles);

    $this->assertContains('Footnote', array_column($this->search('Qwertzuiop lives here.')['pages'], 'title'));
  }

  /**
   * A slug the caller may not read narrows to nothing, not to everything.
   */
  public function testTheSlugOfUnreadableSpaceAnswersNoPage(): void {
    $reader = $this->createUser(['access content']);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Beta handbook', TRUE, "Qwertzuiop lives here.\n", $beta);
    $this->createPage('Handbook page', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $this->setCurrentUser($reader);
    $body = $this->search('Qwertzuiop lives here.', '0', $beta->getSlug());

    $this->assertSame([], $body['pages']);
  }

  /**
   * A query under the query's floor answers nothing, not the nearest page.
   *
   * The question shares no word with the page, so only the vector clause can
   * answer it and the floor is what decides.
   */
  public function testQueriesUnderTheFloorAnswerNoPage(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();
    $this->assertNotSame([], $this->search('Asdfghjkl')['pages']);

    // The highest score the metric can answer, which these fixtures do not
    // reach.
    $this->setRelevanceFloor(1.0);
    $body = $this->search('Asdfghjkl');

    $this->assertSame([], $body['pages']);
    $this->assertFalse($body['has_more']);
  }

  /**
   * A query longer than a phrase is refused before it costs a provider call.
   */
  public function testAnOverLongQueryIsRefused(): void {
    $this->expectException(UnprocessableEntityHttpException::class);
    $this->search(str_repeat('a', 513));
  }

  /**
   * A page that is not a whole number in range is refused.
   */
  public function testThePageThatIsNotWindowIsRefused(): void {
    foreach (['abc', '-5', '1.5', '99'] as $page) {
      try {
        $this->search('Qwertzuiop', $page);
        $this->fail(sprintf('page=%s was accepted.', $page));
      }
      catch (UnprocessableEntityHttpException) {
        // The page is refused, which is what this asserts.
      }
    }
  }

  /**
   * A space that is not spelled like a slug is refused.
   */
  public function testTheSpaceThatIsNotSlugIsRefused(): void {
    $this->expectException(UnprocessableEntityHttpException::class);
    $this->search('Qwertzuiop', '0', 'Alpha Space!');
  }

  /**
   * A refused query is an answer about the query, with nothing to retry.
   */
  public function testTheRefusedQueryAnswersNoMatches(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();
    $this->config('openkb_search_test.settings')->set('embeddings_refuse', TRUE)->save();

    $response = $this->controller->search($this->request('Qwertzuiop lives here.'));
    $body = json_decode((string) $response->getContent(), TRUE);

    $this->assertSame(422, $response->getStatusCode());
    $this->assertSame([], $body['pages']);
    $this->assertNotSame('', $body['refused']);
  }

  /**
   * A provider that cannot answer is unavailability, and says so.
   */
  public function testTheProviderOutageIsUnavailability(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();
    $this->config('openkb_search_test.settings')->set('embeddings_fail', TRUE)->save();

    $this->expectException(ServiceUnavailableHttpException::class);
    $this->controller->search($this->request('Qwertzuiop lives here.'));
  }

  /**
   * The retrieval service, for a case that reads chunks rather than rows.
   */
  private function retrieval(): ChunkRetrievalInterface {
    return $this->container->get(ChunkRetrievalInterface::class);
  }

  /**
   * One request against the route.
   */
  private function request(string $query, string $page = '0', string $space = '', string $type = '', string $author = '', string $updated = ''): Request {
    return Request::create('/openkb/search', 'GET', array_filter([
      'q' => $query,
      'page' => $page,
      'space' => $space,
      'type' => $type,
      'author' => $author,
      'updated' => $updated,
    ]));
  }

  /**
   * The answer body for one query.
   *
   * @return array<string, mixed>
   *   The decoded body.
   */
  private function search(string $query, string $page = '0', string $space = '', string $type = '', string $author = '', string $updated = ''): array {
    return json_decode((string) $this->controller->search($this->request($query, $page, $space, $type, $author, $updated))->getContent(), TRUE);
  }

}
