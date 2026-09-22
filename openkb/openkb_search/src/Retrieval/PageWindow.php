<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Retrieval;

/**
 * One chunk fetch, collapsed to the pages it holds.
 *
 * How many chunks came back is part of the answer: a fetch that filled its
 * window may be hiding further pages, one that did not has none left to give.
 */
final class PageWindow {

  /**
   * Constructs a page window.
   *
   * @param list<\Drupal\openkb_search\Retrieval\PageHit> $pages
   *   The pages the fetch collapsed to, in the order the arm ranks them:
   *   best first on the search arms, closest title first on the title arm.
   * @param int $chunks
   *   How many chunk rows the fetch answered.
   */
  public function __construct(
    public readonly array $pages,
    public readonly int $chunks,
  ) {}

}
