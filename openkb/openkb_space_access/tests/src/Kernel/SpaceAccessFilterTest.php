<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\Tests\openkb_search\Kernel\ChunkIndexTestBase;
use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * A query run in Drupal returns nothing from a space the account cannot read.
 *
 * Runs on the shipped index. The inversion is what makes the rest mean
 * anything: with the processor off both hits appear, so a pass is the filter's
 * doing and not the fixture's.
 *
 * @group openkb_space_access
 */
final class SpaceAccessFilterTest extends ChunkIndexTestBase {

  /**
   * A word only the two probe pages carry, one each.
   */
  private const KEYWORD = 'Qwertzuiop';

  /**
   * The read path under test.
   */
  private ChunkRetrievalInterface $retrieval;

  /**
   * On the Alpha roster only.
   */
  private UserInterface $alphaReader;

  /**
   * On the Beta roster only.
   */
  private UserInterface $betaReader;

  /**
   * On no roster, so it may read no space.
   */
  private UserInterface $outsider;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();

    $this->retrieval = $this->container->get(ChunkRetrievalInterface::class);
    $this->alphaReader = $this->createUser(['access content']);
    $this->betaReader = $this->createUser(['access content']);
    $this->outsider = $this->createUser(['access content']);

    $this->createPage('Alpha page', TRUE, self::KEYWORD . "\n", $this->createSpace('Alpha', $this->alphaReader));
    $this->createPage('Beta page', TRUE, self::KEYWORD . "\n", $this->createSpace('Beta', $this->betaReader));
    $this->indexPages();
    // The vector clause is shut, so what answers is the keyword alone and the
    // assertions are on exact lists.
    $this->setRelevanceFloor(1.0);
  }

  /**
   * Each account is answered its own space, and nothing from the other's.
   */
  public function testAnAccountSeesOnlyItsOwnSpace(): void {
    $this->setCurrentUser($this->alphaReader);
    $this->assertSame(['Alpha page'], $this->search());

    $this->setCurrentUser($this->betaReader);
    $this->assertSame(['Beta page'], $this->search());
  }

  /**
   * Both pages match the keyword — the filter is what keeps one away.
   */
  public function testWithoutTheProcessorBothPagesAreFound(): void {
    $this->index->removeProcessor('space_access_filter')->save();

    $this->setCurrentUser($this->alphaReader);
    $titles = $this->search();
    sort($titles);
    $this->assertSame(['Alpha page', 'Beta page'], $titles);
  }

  /**
   * An account that may read no space is answered nothing, not everything.
   */
  public function testNoReadableSpaceIsNoHits(): void {
    $this->setCurrentUser($this->outsider);
    $this->assertSame([], $this->search());

    $this->setCurrentUser(User::getAnonymousUser());
    $this->assertSame([], $this->search());
  }

  /**
   * The bypass option other processors honour does not widen this one.
   *
   * Space access is the product's read boundary, not a convenience filter, so
   * a query option is no way around it.
   */
  public function testTheAccessBypassOptionIsIgnored(): void {
    $this->setCurrentUser($this->alphaReader);

    $query = $this->index->query();
    $query->setOption('search_api_bypass_access', TRUE);
    $this->index->getProcessor('space_access_filter')->preprocessSearchQuery($query);

    $conditions = $query->getConditionGroup()->getConditions();
    $this->assertCount(1, $conditions);
    $this->assertSame('space', $conditions[0]->getField());
    $this->assertSame('IN', $conditions[0]->getOperator());
    $this->assertContains('Alpha', $conditions[0]->getValue());
    $this->assertNotContains('Beta', $conditions[0]->getValue());

    // And the read itself, which sets that option on every query, is narrowed
    // the same way.
    $this->assertSame(['Alpha page'], $this->search());
  }

  /**
   * The pages the keyword reaches for the current account.
   *
   * The retrieval sets `search_api_bypass_access` on every read.
   *
   * @return list<string>
   *   The titles.
   */
  private function search(): array {
    $window = $this->retrieval->retrievePages(self::KEYWORD, 10);
    return array_map(static fn ($page) => $page->best()->title, $window->pages);
  }

}
