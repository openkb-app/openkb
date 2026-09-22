<?php

declare(strict_types=1);

namespace Drupal\Tests\comark\Kernel;

use Drupal\Tests\openkb_search\Kernel\ChunkIndexTestBase;
use Drupal\path_alias\Entity\PathAlias;

/**
 * A hit has to be linkable without loading the page behind it.
 *
 * The address a page is reached at travels in the indexed row, so a search
 * links to it without a second read. Subject is the `kb_page_path`
 * processor: it writes the relative alias, never the canonical URL, which on a
 * decoupled site carries the frontend origin and would bake a deployment's
 * host into the index.
 *
 * @group comark
 */
final class KbPagePathTest extends ChunkIndexTestBase {

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    // The alias manager skips any path prefix the router does not know, and a
    // kernel container builds no router. `/node/…` is what pages are
    // aliased from, so the list has to carry it for aliases to resolve at all.
    $this->container->get('state')->set('router.path_roots', ['node']);
  }

  /**
   * The alias is what the index carries, not the canonical URL.
   */
  public function testTheAliasIsIndexed(): void {
    $node = $this->createPage('Addressable', TRUE, "Qwertzuiop lives here.\n");
    PathAlias::create([
      'path' => '/node/' . $node->id(),
      'alias' => '/handbook/addressable',
    ])->save();
    // The page was saved before its alias existed, so both caches are
    // holding "no alias for /node". A real save writes the two together.
    $this->clearAliasCaches();

    $this->indexPages();

    $this->assertSame(['/handbook/addressable'], array_column($this->rows(['path']), 'path'));
  }

  /**
   * A page with no alias indexes its system path rather than nothing.
   *
   * The alias manager answers `/node/<nid>` when nothing else is registered,
   * and that address still resolves — a hit is never unlinkable.
   */
  public function testAnUnaliasedPageStillCarriesAnAddress(): void {
    $node = $this->createPage('Unaliased', TRUE, "Qwertzuiop lives here.\n");

    $this->indexPages();

    $this->assertSame(['/node/' . $node->id()], array_column($this->rows(['path']), 'path'));
  }

}
