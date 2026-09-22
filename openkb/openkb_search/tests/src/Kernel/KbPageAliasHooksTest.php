<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\path_alias\Entity\PathAlias;

/**
 * A page that moves takes its indexed address with it.
 *
 * The index carries the alias as `path`, so a hit links without a second read.
 * An alias saved on its own changes no node, and nothing else would tell the
 * index the address moved.
 *
 * @group openkb_search
 */
final class KbPageAliasHooksTest extends ChunkIndexTestBase {

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    // The alias manager skips any path prefix the router does not know, and a
    // kernel container builds no router.
    $this->container->get('state')->set('router.path_roots', ['node']);
  }

  /**
   * Re-aliasing a page re-indexes it under the new address.
   */
  public function testAnAliasChangeReIndexesThePage(): void {
    $node = $this->createPage('Movable', TRUE, "Qwertzuiop lives here.\n");
    $alias = PathAlias::create([
      'path' => '/node/' . $node->id(),
      'alias' => '/handbook/movable',
    ]);
    $alias->save();
    $this->clearAliasCaches();
    $this->indexPages();
    $this->assertSame(['/handbook/movable'], $this->paths());

    $alias->set('alias', '/handbook/moved')->save();
    $this->clearAliasCaches();
    // Nothing but the alias changed, so the one page the hook marked is
    // all there is to index.
    $this->assertSame(1, $this->index->indexItems());

    $this->assertSame(['/handbook/moved'], $this->paths());
  }

  /**
   * Deleting an alias re-indexes the page under its system path.
   */
  public function testTheDeletedAliasReIndexesThePage(): void {
    $node = $this->createPage('Droppable', TRUE, "Qwertzuiop lives here.\n");
    $alias = PathAlias::create([
      'path' => '/node/' . $node->id(),
      'alias' => '/handbook/droppable',
    ]);
    $alias->save();
    $this->clearAliasCaches();
    $this->indexPages();
    $this->assertSame(['/handbook/droppable'], $this->paths());

    $alias->delete();
    $this->clearAliasCaches();
    $this->assertSame(1, $this->index->indexItems());

    $this->assertSame(['/node/' . $node->id()], $this->paths());
  }

  /**
   * An alias moved to another page re-indexes both of them.
   *
   * The page that lost the alias falls back to its system path, so its
   * address moved too.
   */
  public function testAnAliasMovedToAnotherPageReIndexesBoth(): void {
    $from = $this->createPage('Giver', TRUE, "Qwertzuiop lives here.\n");
    $to = $this->createPage('Taker', TRUE, "Qwertzuiop lives here too.\n");
    $alias = PathAlias::create([
      'path' => '/node/' . $from->id(),
      'alias' => '/handbook/shared',
    ]);
    $alias->save();
    $this->clearAliasCaches();
    $this->indexPages();

    $alias->set('path', '/node/' . $to->id())->save();
    $this->clearAliasCaches();
    $this->assertSame(2, $this->index->indexItems());

    $this->assertSame([
      'Giver' => '/node/' . $from->id(),
      'Taker' => '/handbook/shared',
    ], $this->pathByTitle());
  }

  /**
   * An alias that names something other than a page changes nothing.
   */
  public function testAnAliasOnAnotherPathIsIgnored(): void {
    $this->createPage('Untouched', TRUE, "Qwertzuiop lives here.\n");
    $this->indexPages();

    PathAlias::create(['path' => '/user/1', 'alias' => '/somebody'])->save();

    $this->assertSame(0, $this->index->indexItems());
  }

  /**
   * The address every indexed row carries, in document order.
   *
   * @return list<string>
   *   One path per row.
   */
  private function paths(): array {
    return array_values(array_unique(array_column($this->rows(['path']), 'path')));
  }

  /**
   * The address each indexed page carries, keyed by its title.
   *
   * @return array<string, string>
   *   One path per page.
   */
  private function pathByTitle(): array {
    $paths = [];
    foreach ($this->rows(['path', 'title']) as $row) {
      $paths[$row['title']] = $row['path'];
    }
    return $paths;
  }

}
