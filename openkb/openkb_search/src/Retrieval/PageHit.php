<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Retrieval;

/**
 * One page, with every section of it the query matched.
 *
 * What the search page shows as a row: the page is named once, the best
 * section is the excerpt the row opens on, and the rest are the sub-links
 * beside it. Built from the chunk rows and nothing else, so a row costs no
 * entity load.
 */
final class PageHit {

  /**
   * Constructs a page hit.
   *
   * @param list<\Drupal\openkb_search\Retrieval\ChunkHit> $sections
   *   The page's matching sections, best first. Never empty: a page is a hit
   *   because a section of it is.
   */
  public function __construct(
    public readonly array $sections,
  ) {}

  /**
   * The section the page is ranked and excerpted by.
   */
  public function best(): ChunkHit {
    return $this->sections[0];
  }

  /**
   * The page's score: its best section's.
   */
  public function score(): float {
    return $this->best()->score;
  }

}
