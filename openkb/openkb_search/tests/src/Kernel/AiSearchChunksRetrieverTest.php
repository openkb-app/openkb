<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\ai_rag_cite\RetrieverInterface;
use Drupal\ai_rag_cite\ValueObject\Source;
use Drupal\openkb_space\SpaceStorage;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * What the chat is grounded on, read off the chunk index.
 *
 * The citation shape the client renders does not change with block-level
 * retrieval: the path carries the anchor, the meta line the headings, the
 * excerpt the section's own text.
 *
 * @group openkb_search
 */
final class AiSearchChunksRetrieverTest extends ChunkIndexTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'ai_assistant_api',
    'ai_rag_cite',
  ];

  /**
   * On the Alpha roster only.
   */
  private UserInterface $alphaReader;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->alphaReader = $this->createUser(['access content']);
  }

  /**
   * A source is one section, cited at the block it opens on.
   */
  public function testSourceIsOneSection(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT before the first day.\n");
    $this->indexPages();

    $sources = $this->retrieve('Ask IT before the first day.');
    $this->assertCount(2, $sources, 'Both sections of the page are offered.');
    $source = $this->sourceOf($sources, 'Onboarding › Accounts');

    $this->assertSame('Onboarding', $source->title);
    $this->assertStringContainsString('Ask IT before the first day.', $source->excerpt);
    $this->assertMatchesRegularExpression('/#[^#]+$/', $source->path, 'The path lands on the block.');
    $this->assertMatchesRegularExpression('#^entity:node/\d+:en$#', $source->entityId);
  }

  /**
   * Both sections of one page count as one page, so the cap can hold.
   */
  public function testSectionsOfOnePageShareTheirEntityId(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT.\n");
    $this->indexPages();

    $ids = array_map(fn (Source $source) => $source->entityId, $this->retrieve('Ask IT.'));
    $this->assertCount(2, $ids);
    $this->assertCount(1, array_unique($ids));
  }

  /**
   * The citation the client renders keeps its shape.
   *
   * A page that cites something too: what a section is derived from reaches
   * the source the retriever builds, and stops there. The citation on the wire
   * is the five keys the client has always read.
   */
  public function testTheCitationShapeIsUnchanged(): void {
    $this->createPage('Onboarding', TRUE, "Read this first.\n\n## Accounts\n\nAsk IT. :citation{nid=\"42\" block=\"b-4f2a\" v=\"aaaaaaaaaaaa\"}\n");
    $this->indexPages();

    $source = $this->sourceOf($this->retrieve('Ask IT.'), 'Onboarding › Accounts');
    $this->assertSame(['42', '42#b-4f2a'], $source->cites);

    $citation = $source->toCitation(1);
    $this->assertSame(['n', 'title', 'path', 'meta', 'score'], array_keys($citation));
    $this->assertSame(1, $citation['n']);
    $this->assertSame('Onboarding', $citation['title']);
    $this->assertSame('Onboarding › Accounts', $citation['meta']);
    $this->assertStringContainsString('#', $citation['path']);
  }

  /**
   * A page of a space the account is not on grounds no answer.
   */
  public function testForeignSpaceGroundsNothing(): void {
    $alpha = $this->createSpace('Alpha', $this->alphaReader);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Alpha handbook', TRUE, "Qwertzuiop lives here.\n", $alpha);
    $this->createPage('Beta handbook', TRUE, "Qwertzuiop lives here.\n", $beta);
    $this->indexPages();

    $this->setCurrentUser($this->alphaReader);
    $this->assertSame(
      ['Alpha handbook'],
      array_values(array_unique(array_map(fn (Source $source) => $source->title, $this->retrieve('Qwertzuiop lives here.')))),
    );

    $this->setCurrentUser(User::getAnonymousUser());
    $this->assertSame([], $this->retrieve('Qwertzuiop lives here.'));
  }

  /**
   * A scope names a space by its slug, and narrows the turn to it.
   */
  public function testTheScopeNarrowsToTheSpaceItNames(): void {
    $this->twoSpaces();

    $this->assertSame(
      ['Alpha handbook'],
      $this->titles($this->retrieve('Qwertzuiop lives here.', ['scope' => 'alpha'])),
    );
    $this->assertSame(
      ['Beta handbook'],
      $this->titles($this->retrieve('Qwertzuiop lives here.', ['scope' => 'beta'])),
    );
  }

  /**
   * Every readable space answers when the scope names none.
   */
  public function testEveryReadableSpaceAnswersUnderTheWholeScope(): void {
    $this->twoSpaces();

    foreach ([[], ['scope' => 'all'], ['scope' => '']] as $context) {
      $this->assertSame(
        ['Alpha handbook', 'Beta handbook'],
        $this->titles($this->retrieve('Qwertzuiop lives here.', $context)),
      );
    }
  }

  /**
   * The plugin takes no narrowing setting; only the turn's context narrows.
   */
  public function testTheRetrieverHasNoNarrowingSettings(): void {
    $this->twoSpaces();

    /** @var \Drupal\ai_rag_cite\RetrieverInterface $retriever */
    $retriever = $this->container->get('plugin.manager.ai_rag_cite_retriever')
      ->createInstance('ai_search_chunks', ['top_k' => 10, 'space' => 'Beta', 'type' => 'guide']);

    $this->assertSame(['top_k'], array_keys($retriever->defaultConfiguration()));
    $this->assertSame(
      ['Alpha handbook', 'Beta handbook'],
      $this->titles($retriever->retrieve('Qwertzuiop lives here.')),
      'Settings left on the plugin are not read.',
    );
  }

  /**
   * A scope naming no space narrows to nothing, rather than to everything.
   */
  public function testScopeNamingNoSpaceAnswersNothing(): void {
    $this->twoSpaces();

    $this->assertSame([], $this->retrieve('Qwertzuiop lives here.', ['scope' => 'no-such-space']));
  }

  /**
   * The open page's space leads, and no score moves for it.
   */
  public function testThePageSpaceLeadsWithoutMovingTheScores(): void {
    $this->twoSpaces('Handbook');

    $toAlpha = $this->retrieve('Qwertzuiop lives here.', ['space' => 'alpha']);
    $toBeta = $this->retrieve('Qwertzuiop lives here.', ['space' => 'beta']);

    $this->assertSame($this->entityIdOf('alpha'), $toAlpha[0]->entityId, 'The read page\'s space leads.');
    $this->assertSame($this->entityIdOf('beta'), $toBeta[0]->entityId, 'And so does the other one.');
    $this->assertSame($this->scores($toAlpha), $this->scores($toBeta), 'The lift orders; it does not score.');
  }

  /**
   * A picked scope is the narrowing; the page's space does not widen it.
   */
  public function testThePickedScopeOutranksThePageSpace(): void {
    $this->twoSpaces();

    $this->assertSame(
      ['Alpha handbook'],
      $this->titles($this->retrieve('Qwertzuiop lives here.', ['scope' => 'alpha', 'space' => 'beta'])),
    );
  }

  /**
   * Two spaces the reader is on, each with one page saying the same thing.
   *
   * @param string|null $title
   *   One title for both pages, so their sections score alike; by default each
   *   page is titled after its own space.
   */
  private function twoSpaces(?string $title = NULL): void {
    $alpha = $this->createSpace('Alpha', $this->alphaReader);
    $beta = $this->createSpace('Beta', $this->alphaReader);
    $this->createPage($title ?? 'Alpha handbook', TRUE, "Qwertzuiop lives here.\n", $alpha);
    $this->createPage($title ?? 'Beta handbook', TRUE, "Qwertzuiop lives here.\n", $beta);
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);
  }

  /**
   * The id of the page filed in the space the slug names.
   */
  private function entityIdOf(string $slug): string {
    $entityTypeManager = $this->container->get('entity_type.manager');
    $space = SpaceStorage::get($entityTypeManager)->getBySlug($slug);
    $this->assertNotNull($space);
    $ids = $entityTypeManager->getStorage('node')->getQuery()
      ->accessCheck(FALSE)
      ->condition('field_space', $space->id())
      ->execute();
    return 'entity:node/' . reset($ids) . ':en';
  }

  /**
   * The titles the sources name, each once, in a stable order.
   *
   * @param \Drupal\ai_rag_cite\ValueObject\Source[] $sources
   *   The sources.
   *
   * @return list<string>
   *   The titles.
   */
  private function titles(array $sources): array {
    $titles = array_values(array_unique(array_map(fn (Source $source) => $source->title, $sources)));
    sort($titles);
    return $titles;
  }

  /**
   * What each source scored, by the page it came from, so an order can move.
   *
   * @param \Drupal\ai_rag_cite\ValueObject\Source[] $sources
   *   The sources.
   *
   * @return array<string, list<float>>
   *   The scores, keyed by entity id.
   */
  private function scores(array $sources): array {
    $scores = [];
    foreach ($sources as $source) {
      $scores[$source->entityId][] = $source->score;
    }
    foreach ($scores as &$one) {
      sort($one);
    }
    ksort($scores);
    return $scores;
  }

  /**
   * The source whose meta line is the one named.
   *
   * @param \Drupal\ai_rag_cite\ValueObject\Source[] $sources
   *   The sources.
   * @param string $meta
   *   The heading line the section sits under.
   */
  private function sourceOf(array $sources, string $meta): Source {
    foreach ($sources as $source) {
      if ($source->meta === $meta) {
        return $source;
      }
    }
    $this->fail(sprintf('No source under "%s"; the sources were %s.', $meta, json_encode(array_map(
      fn (Source $source) => $source->meta,
      $sources,
    ))));
  }

  /**
   * What the retriever answers for a question, in the caller's context.
   *
   * @param string $query
   *   The question.
   * @param array<string, mixed> $context
   *   The caller context the turn would arrive with.
   *
   * @return \Drupal\ai_rag_cite\ValueObject\Source[]
   *   The sources.
   */
  private function retrieve(string $query, array $context = []): array {
    /** @var \Drupal\ai_rag_cite\RetrieverInterface $retriever */
    $retriever = $this->container->get('plugin.manager.ai_rag_cite_retriever')
      ->createInstance('ai_search_chunks', ['top_k' => 10]);
    $this->assertInstanceOf(RetrieverInterface::class, $retriever);
    return $retriever->retrieve($query, $context);
  }

}
