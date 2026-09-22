<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Retrieval;

/**
 * Hybrid retrieval over the chunk index, scoped to the account.
 *
 * The one read path both AI consumers share (ADR 0009, ADR 0010): the chat
 * grounding in-process and the search_pages tool over MCP. Access is the
 * index's space_access_filter processor on every query; the caller never
 * filters by hand and never loads an entity.
 */
interface ChunkRetrievalInterface {

  /**
   * Retrieves the best-matching chunks for a query.
   *
   * @param string $query
   *   The natural-language query. Embedded by the index's engine for the
   *   vector clause, and matched as terms by the lexical one.
   * @param int $topK
   *   How many chunks to answer at most.
   * @param array<string, mixed> $options
   *   Retrieval options, each keyed by an attribute of the index: a keyword
   *   one narrows to that value (`space`, `type`, `tags`, `owner`,
   *   `contributors`, `cites`, `links`), a date one to the rows at or after
   *   it (`changed`, `created`). An empty value narrows nothing.
   *
   *   `cites` and `links` are the reverse lookup: `"42"` answers the sections
   *   referencing that page, `"42#b-4f2a"` the ones referencing that block.
   *
   * @return list<\Drupal\openkb_search\Retrieval\ChunkHit>
   *   Hits, best first.
   *
   * @throws \InvalidArgumentException
   *   When an option names no attribute of the index a search narrows by.
   * @throws \Drupal\openkb_search\Retrieval\QueryRefusedException
   *   When the provider refused the query itself; nothing matches, and a
   *   retry of the same words cannot.
   * @throws \Drupal\search_api\SearchApiException
   *   When the index cannot be queried; unavailability, not "no matches".
   */
  public function retrieve(string $query, int $topK, array $options = []): array;

  /**
   * Retrieves the same chunks, collapsed to one hit per page.
   *
   * The search page's read: a page is ranked by its best section and keeps
   * every other matching section beside it. Two query words in two sections
   * of one page do not meet, and repeated matches do not add up.
   *
   * @param string $query
   *   The natural-language query. Embedded by the index's engine.
   * @param int $topK
   *   How many chunks to fetch before collapsing. Pages are answered out of
   *   that window, so it bounds how many pages can come back.
   * @param array<string, mixed> $options
   *   Retrieval options, as retrieve() documents them.
   *
   * @return \Drupal\openkb_search\Retrieval\PageWindow
   *   The pages, best first, and how many chunks the fetch answered.
   *
   * @throws \Drupal\openkb_search\Retrieval\QueryRefusedException
   *   When the provider refused the query itself; nothing matches, and a
   *   retry of the same words cannot.
   * @throws \Drupal\search_api\SearchApiException
   *   When the index cannot be queried; unavailability, not "no matches".
   */
  public function retrievePages(string $query, int $topK, array $options = []): PageWindow;

  /**
   * Retrieves the pages whose title starts with what was typed.
   *
   * The lexical arm alone, over the analyzed `title` attribute: what is being
   * typed is a prefix, not a question, so nothing is embedded and no provider
   * is called. Collapsed to one hit per page like retrievePages(), since the
   * title sits on every chunk of a page, and offered closest title first: the
   * one the typed words spell, then the shortest carrying them.
   *
   * @param string $prefix
   *   The words typed so far. The last one matches a title word it starts.
   * @param int $topK
   *   How many chunks to fetch before collapsing.
   * @param array<string, mixed> $options
   *   Retrieval options, as retrieve() documents them.
   *
   * @return \Drupal\openkb_search\Retrieval\PageWindow
   *   The pages, closest title first, and how many chunks the fetch
   *   answered.
   *
   * @throws \Drupal\search_api\SearchApiException
   *   When the index cannot be queried; unavailability, not "no matches".
   */
  public function retrieveTitlePages(string $prefix, int $topK, array $options = []): PageWindow;

}
