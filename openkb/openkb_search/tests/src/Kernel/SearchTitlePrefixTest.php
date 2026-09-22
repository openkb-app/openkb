<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\openkb_search\Controller\SearchController;
use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * What `GET /openkb/search?title=` answers, against the live chunk index.
 *
 * The lexical arm on its own: the word being typed matches the title word it
 * starts, and nothing is embedded on the way — an embeddings call per
 * keystroke is what the arm exists to avoid.
 *
 * @group openkb_search
 */
final class SearchTitlePrefixTest extends ChunkIndexTestBase {

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
   * A page is offered for a word its title starts with.
   */
  public function testTypedPrefixOffersThePagesItsTitleStarts(): void {
    $this->createPage('Release checklist', TRUE, "Qwertzuiop lives here.\n");
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here too.\n");
    $this->indexPages();

    $pages = $this->titles('Rel');

    $this->assertSame(['Release checklist'], array_column($pages, 'title'));
    $this->assertSame('Handbook', $pages[0]['space']);
    $this->assertNotSame('', $pages[0]['path']);
  }

  /**
   * The offer is made on the title alone, not on what a page says.
   */
  public function testTheBodyOffersNothing(): void {
    $this->createPage('Onboarding', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    $this->assertSame([], $this->titles('Qwertzuiop'));
  }

  /**
   * Nothing is embedded for a prefix: the provider is never asked.
   */
  public function testNothingIsEmbedded(): void {
    $this->createPage('Release checklist', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();
    $embedded = $this->embeddedTexts();
    // Indexing embeds, so a recorder that answered nothing would pass the
    // assertion below however much the read embedded.
    $this->assertNotSame([], $embedded);

    $this->assertSame(['Release checklist'], array_column($this->titles('Rel'), 'title'));
    $this->assertSame($embedded, $this->embeddedTexts());
  }

  /**
   * Two pages sharing a prefix keep an order: the closer title leads.
   *
   * A prefix matches every title carrying it and scores them alike, so
   * without an order of its own the offers come back in whatever order the
   * index holds them — the longer title as readily as the typed one.
   */
  public function testTheCloserTitleLeadsTwoThatStartAlike(): void {
    // Created first, so index order alone would put the longer title on top.
    $this->createPage('Qwertzuiop target archive notes', TRUE, "Lives here.\n");
    $this->createPage('Qwertzuiop target notes', TRUE, "Lives here too.\n");
    $this->indexPages();

    $titles = array_column($this->titles('Qwertzuiop t'), 'title');

    $this->assertSame('Qwertzuiop target notes', $titles[0]);
  }

  /**
   * The page whose title is being typed leads at every stem of it.
   *
   * What the picker's caller is typing is a title; the page that spells it
   * has to lead the one that merely starts the same way, at every stem of it.
   */
  public function testTheTypedTitleLeadsAtEveryStem(): void {
    // Created first, so index order alone would put the longer title on top.
    $this->createPage('Deployment runbook', TRUE, "Lives here.\n");
    $this->createPage('Deployment', TRUE, "Lives here too.\n");
    $this->indexPages();

    foreach (['Deploy', 'Deploym', 'Deployment'] as $stem) {
      $titles = array_column($this->titles($stem), 'title');
      $this->assertSame(['Deployment', 'Deployment runbook'], $titles, sprintf('The offers for "%s".', $stem));
    }
  }

  /**
   * A page of a space the account is not on is never offered.
   */
  public function testForeignSpacesAreNeverOffered(): void {
    $reader = $this->createUser(['access content']);
    $alpha = $this->createSpace('Alpha', $reader);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Release checklist', TRUE, "Qwertzuiop.\n", $alpha);
    $this->createPage('Release notes', TRUE, "Qwertzuiop.\n", $beta);
    $this->indexPages();

    $this->setCurrentUser($reader);
    $this->assertSame(['Release checklist'], array_column($this->titles('Rel'), 'title'));
  }

  /**
   * The `space` parameter narrows the offers to one space.
   */
  public function testTheSpaceParameterNarrowsTheOffers(): void {
    $alpha = $this->createSpace('Alpha', $this->createUser(['access content']));
    $this->createPage('Release checklist', TRUE, "Qwertzuiop.\n", $alpha);
    $this->createPage('Release notes', TRUE, "Qwertzuiop.\n");
    $this->indexPages();

    $this->assertSame(['Release checklist'], array_column($this->titles('Rel', $alpha->getSlug()), 'title'));
    $this->assertSame([], $this->titles('Rel', 'no-such-space'));
  }

  /**
   * One page is offered once, however many chunks its title sits on.
   */
  public function testOnePageIsOfferedOnce(): void {
    $this->createPage('Release checklist', TRUE, "Qwertzuiop.\n\n## Steps\n\nQwertzuiop again.\n");
    $this->indexPages();

    $this->assertSame(['Release checklist'], array_column($this->titles('Rel'), 'title'));
  }

  /**
   * A prefix over the length limit is the request being wrong.
   */
  public function testAnOversizedPrefixIsRefused(): void {
    $this->expectException(UnprocessableEntityHttpException::class);
    $this->controller->search(Request::create('/openkb/search', 'GET', ['title' => str_repeat('a', 129)]));
  }

  /**
   * A request naming both reads is refused rather than answered as one.
   */
  public function testQueryAndPrefixTogetherAreRefused(): void {
    $this->expectException(UnprocessableEntityHttpException::class);
    $this->expectExceptionMessage('A request names a query or a title prefix, not both.');
    $this->controller->search(Request::create('/openkb/search', 'GET', ['title' => 'Rel', 'q' => 'Qwertzuiop']));
  }

  /**
   * Naming both is what an empty prefix beside a query is refused for.
   */
  public function testAnEmptyPrefixBesideTheQueryNamesBothReads(): void {
    $this->expectException(UnprocessableEntityHttpException::class);
    $this->expectExceptionMessage('A request names a query or a title prefix, not both.');
    $this->controller->search(Request::create('/openkb/search', 'GET', ['title' => '', 'q' => 'Qwertzuiop']));
  }

  /**
   * A filter or a window beside a prefix is refused, not ignored.
   */
  public function testWhatTheTitleArmCannotAnswerIsRefused(): void {
    foreach (['type' => 'runbook', 'author' => 'rosa', 'updated' => 'week', 'page' => '3'] as $name => $value) {
      try {
        $this->controller->search(Request::create('/openkb/search', 'GET', ['title' => 'Rel', $name => $value]));
        $this->fail(sprintf('%s was accepted beside a title prefix.', $name));
      }
      catch (UnprocessableEntityHttpException) {
        // The parameter is refused, which is what this asserts.
      }
    }
  }

  /**
   * An empty prefix is the title read with nothing to match, so it is refused.
   *
   * Answering it would hand back the listing's shape to a caller that asked
   * for the title arm's.
   */
  public function testAnEmptyPrefixIsRefused(): void {
    $this->expectException(UnprocessableEntityHttpException::class);
    $this->expectExceptionMessage('A title prefix is at least one character.');
    $this->controller->search(Request::create('/openkb/search', 'GET', ['title' => '']));
  }

  /**
   * A request naming no title at all is the route's other arms.
   */
  public function testNoPrefixIsNotTheTitleRead(): void {
    $this->createPage('Release checklist', TRUE, "Qwertzuiop.\n");
    $this->indexPages();

    $body = json_decode((string) $this->controller->search(
      Request::create('/openkb/search', 'GET'),
    )->getContent(), TRUE);

    $this->assertArrayHasKey('page_size', $body);
    $this->assertSame(['Release checklist'], array_column($body['pages'], 'title'));
  }

  /**
   * The retrieval answers the same pages the route does.
   */
  public function testTheRetrievalAnswersThePagesTheRouteDoes(): void {
    $this->createPage('Release checklist', TRUE, "Qwertzuiop.\n");
    $this->indexPages();

    $window = $this->container->get(ChunkRetrievalInterface::class)->retrieveTitlePages('Rel', 60);

    $this->assertCount(1, $window->pages);
    $this->assertSame('Release checklist', $window->pages[0]->best()->title);
  }

  /**
   * The pages a typed prefix offers.
   *
   * @return list<array<string, string>>
   *   The rows.
   */
  private function titles(string $prefix, string $space = ''): array {
    $body = json_decode((string) $this->controller->search(
      Request::create('/openkb/search', 'GET', array_filter(['title' => $prefix, 'space' => $space])),
    )->getContent(), TRUE);
    return $body['pages'];
  }

}
