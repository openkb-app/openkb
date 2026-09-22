<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Controller;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Entity\Query\QueryInterface;
use Drupal\Core\Logger\LoggerChannelInterface;
use Drupal\Core\Utility\Error;
use Drupal\node\NodeInterface;
use Drupal\openkb_search\Retrieval\PageTypes;
use Drupal\openkb_search\Retrieval\ChunkHit;
use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Drupal\openkb_search\Retrieval\PageHit;
use Drupal\openkb_search\Retrieval\PageWindow;
use Drupal\openkb_search\Retrieval\QueryRefusedException;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_space\SpaceStorage;
use Drupal\path_alias\AliasManagerInterface;
use Drupal\search_api\SearchApiException;
use Psr\Log\LogLevel;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * The search page's read.
 *
 *   GET /openkb/search?q=…[&page=0][&space=…][&type=…][&author=…][&updated=…]
 *   GET /openkb/search?title=…[&space=…]
 *
 * Three arms. The first two share one row shape:
 *
 *   - **A query** is answered off the chunk index. One row per page, as the
 *     reader sees it: the page's best-matching section is its excerpt and the
 *     link's anchor, and every other section it matched is listed beside it.
 *     The query is {@see ChunkRetrievalInterface::retrievePages}, the same read
 *     the chat and the `search_pages` tool run, so no surface can be answered a
 *     page the others would not get. Access is the index's
 *     `space_access_filter`; nothing here filters by hand.
 *   - **No query** lists the newest pages instead, straight off the entity
 *     query. A browse has nothing to rank by and no section to point at, so
 *     nothing is embedded and no index is touched. Access is the node grants
 *     the space roster writes, enforced in SQL by the query's access check.
 *   - **A title prefix** offers the pages whose title starts with the words
 *     being typed, as `{"pages": [{id, title, path, space, type,
 *     highlights}]}`. The lexical clause of the chunk index alone: nothing is
 *     embedded, so the offer costs no provider call and a keystroke can ask
 *     for it.
 *
 * Only the listing counts. A search's window is what was fetched — the
 * collapse runs after the chunk fetch — so its `total` is NULL and `has_more`
 * is all the answer says about what follows.
 */
final class SearchController implements ContainerInjectionInterface {

  /**
   * Pages in one window.
   */
  private const PAGE_SIZE = 10;

  /**
   * Chunks fetched per page of results, before the collapse.
   *
   * A page matches with several of its sections, so a window of ten pages
   * needs more than ten chunks to fill. Six is what the concept starts on;
   * a window that collapses to too few pages is refetched wider.
   */
  private const CHUNKS_PER_PAGE = 6;

  /**
   * The widest chunk fetch one request may ask the index for.
   *
   * A kNN's cost grows with `k`, so paging runs out rather than letting a
   * deep page number turn into an unbounded scan.
   */
  private const MAX_CHUNKS = 300;

  /**
   * The deepest window the listing pages to.
   *
   * A browse is walked, not jumped into, and the query behind a window scans
   * every row it skips.
   */
  private const LAST_LISTING_PAGE = 999;

  /**
   * The longest query the provider is asked to embed.
   *
   * A search query is a phrase. Anything longer is not one, and embedding it
   * costs a provider call.
   */
  private const MAX_QUERY_LENGTH = 512;

  /**
   * The longest title prefix the index is asked to match.
   */
  private const MAX_TITLE_LENGTH = 128;

  /**
   * Pages the title arm offers, and the chunks its first fetch asks for.
   *
   * The title sits on every chunk of a page, so a fetch collapses to far
   * fewer pages than rows — and how many rows a page holds is not known
   * before it. A fetch that collapses to too few pages is refetched wider,
   * up to {@see self::MAX_CHUNKS}.
   */
  private const TITLE_PAGES = 8;
  private const TITLE_CHUNKS = 60;

  /**
   * What a space slug may be built of, and how long it may be.
   */
  private const SLUG_PATTERN = '#^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$#';

  /**
   * The longest an author's name may be; the user name field's own length.
   */
  private const MAX_AUTHOR_LENGTH = 60;

  /**
   * How far back each `updated` range reaches, in seconds.
   */
  private const UPDATED_RANGES = [
    'week' => 7 * 86400,
    'month' => 30 * 86400,
    'year' => 365 * 86400,
  ];

  public function __construct(
    private readonly ChunkRetrievalInterface $retrieval,
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly AliasManagerInterface $aliasManager,
    private readonly LoggerChannelInterface $logger,
    private readonly PageTypes $types,
    private readonly TimeInterface $time,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get(ChunkRetrievalInterface::class),
      $container->get('entity_type.manager'),
      $container->get('path_alias.manager'),
      $container->get('logger.factory')->get('openkb_search'),
      $container->get(PageTypes::class),
      $container->get('datetime.time'),
    );
  }

  /**
   * Answers the pages a query matches, or the newest pages where none is asked.
   */
  public function search(Request $request): JsonResponse {
    $query = $this->query($request);
    $title = $this->title($request, $query);
    $slug = $this->slug($request);

    if ($title !== '') {
      $this->refuseBesideTitle($request);
      $space = $slug === '' ? NULL : $this->spaceBySlug($slug);
      // A slug naming no space the caller may read narrows to nothing, the
      // way the slug of a space they may not read does.
      return new JsonResponse([
        'pages' => $slug !== '' && $space === NULL ? [] : $this->titlePages($title, $space),
      ]);
    }

    $type = $this->type($request);
    $author = $this->author($request);
    $changed = $this->changedSince($request);
    $page = $this->page($request, $query === '' ? self::LAST_LISTING_PAGE : $this->lastPage());
    $space = $slug === '' ? NULL : $this->spaceBySlug($slug);

    if ($slug !== '' && $space === NULL) {
      return new JsonResponse($this->answer($query, $page, [], FALSE, $query === '' ? 0 : NULL));
    }

    if ($query === '') {
      return new JsonResponse($this->listing($page, $space, $type, $author, $changed));
    }

    try {
      $window = $this->window($query, $page, [
        'space' => $space?->label() ?? '',
        'type' => $type,
        'owner' => $author,
        'changed' => $changed,
      ]);
    }
    catch (QueryRefusedException $e) {
      // The caller's own words were refused, so no page can match them and a
      // retry cannot change that. The body is the no-match answer, and the
      // status says the query is what was rejected. A refusal is about the
      // input, not a fault of ours, so it is a notice.
      Error::logException($this->logger, $e, level: LogLevel::NOTICE);
      return new JsonResponse(
        $this->answer($query, $page, [], FALSE, NULL) + ['refused' => 'The words of this query were refused.'],
        Response::HTTP_UNPROCESSABLE_ENTITY,
      );
    }
    catch (SearchApiException $e) {
      // The index could not be queried: unavailability, not "no matches". The
      // detail stays in the log — it names infrastructure.
      Error::logException($this->logger, $e);
      throw new ServiceUnavailableHttpException(NULL, 'Search is unavailable.');
    }

    return new JsonResponse($this->answer(
      $query,
      $page,
      array_map($this->toPage(...), array_slice($window->pages, $page * self::PAGE_SIZE, self::PAGE_SIZE)),
      count($window->pages) > ($page + 1) * self::PAGE_SIZE && $page < $this->lastPage(),
      NULL,
    ));
  }

  /**
   * The newest pages the caller may read, as one window of the listing.
   *
   * @param int $page
   *   The zero-based window asked for.
   * @param \Drupal\openkb_space\SpaceInterface|null $space
   *   The space to narrow to, or NULL for every space the caller may read.
   * @param string $type
   *   The document type to narrow to, or '' for every type.
   * @param string $author
   *   The user name to narrow to, or '' for every author.
   * @param int|null $changed
   *   The moment a page must have changed since, or NULL for any.
   *
   * @return array<string, mixed>
   *   The body.
   */
  private function listing(int $page, ?SpaceInterface $space, string $type, string $author, ?int $changed): array {
    $storage = $this->entityTypeManager->getStorage('node');
    $query = $this->listingQuery($space, $type, $author, $changed)
      ->sort('changed', 'DESC')
      // Pages saved within the same second would otherwise sit in whatever
      // order the storage answers, and a window could show one of them twice.
      ->sort('nid', 'DESC')
      // One past the window is what says a further window exists.
      ->range($page * self::PAGE_SIZE, self::PAGE_SIZE + 1);
    $ids = array_values($query->execute());
    $window = array_slice($ids, 0, self::PAGE_SIZE);
    // loadMultiple() answers keyed by id, in no order of its own.
    $nodes = $storage->loadMultiple($window);

    $rows = [];
    foreach ($window as $id) {
      if (isset($nodes[$id])) {
        $rows[] = $this->toListedPage($nodes[$id]);
      }
    }
    $total = (int) $this->listingQuery($space, $type, $author, $changed)->count()->execute();
    return $this->answer('', $page, $rows, count($ids) > self::PAGE_SIZE, $total);
  }

  /**
   * The published pages the caller may read, unordered and unwindowed.
   *
   * @param \Drupal\openkb_space\SpaceInterface|null $space
   *   The space to narrow to, or NULL for every space the caller may read.
   * @param string $type
   *   The document type to narrow to, or '' for every type.
   * @param string $author
   *   The user name to narrow to, or '' for every author.
   * @param int|null $changed
   *   The moment a page must have changed since, or NULL for any.
   *
   * @return \Drupal\Core\Entity\Query\QueryInterface
   *   The query, for the caller to sort, window or count.
   */
  private function listingQuery(?SpaceInterface $space, string $type, string $author, ?int $changed): QueryInterface {
    $query = $this->entityTypeManager->getStorage('node')->getQuery()
      // The space roster writes node grants, so the access check is what
      // scopes the listing — the same answer the page itself gives.
      ->accessCheck(TRUE)
      ->condition('type', 'kb_page')
      ->condition('status', NodeInterface::PUBLISHED)
      // The window is cut before the revision rows are deduped, so a
      // translated page would otherwise eat a row of somebody's window.
      ->condition('default_langcode', 1);
    if ($space !== NULL) {
      $query->condition('field_space', $space->id());
    }
    if ($type !== '') {
      $query->condition('field_type', $type);
    }
    if ($author !== '') {
      // The frontmatter's owner, which is what the index carries as `owner`
      // and what the Author chip offers — not whoever saved the node.
      $query->condition('field_owner.entity.name', $author);
    }
    if ($changed !== NULL) {
      $query->condition('changed', $changed, '>=');
    }
    return $query;
  }

  /**
   * The query as asked for, refusing one no search box would send.
   */
  private function query(Request $request): string {
    $query = trim((string) $request->query->get('q', ''));
    if (mb_strlen($query) > self::MAX_QUERY_LENGTH) {
      throw new UnprocessableEntityHttpException(sprintf('A query is at most %d characters.', self::MAX_QUERY_LENGTH));
    }
    return $query;
  }

  /**
   * The title prefix asked for, '' where the URL carries none.
   *
   * A title and a query name two different reads of two different shapes, so
   * a request carrying both is rejected rather than answered as one of them,
   * and a title carrying nothing is refused rather than answered in the
   * listing's shape.
   */
  private function title(Request $request, string $query): string {
    if (!$request->query->has('title')) {
      return '';
    }
    if ($query !== '') {
      throw new UnprocessableEntityHttpException('A request names a query or a title prefix, not both.');
    }
    $title = trim((string) $request->query->get('title', ''));
    if ($title === '') {
      throw new UnprocessableEntityHttpException('A title prefix is at least one character.');
    }
    if (mb_strlen($title) > self::MAX_TITLE_LENGTH) {
      throw new UnprocessableEntityHttpException(sprintf('A title prefix is at most %d characters.', self::MAX_TITLE_LENGTH));
    }
    return $title;
  }

  /**
   * Refuses what the title arm cannot answer.
   *
   * The arm offers one un-paged list of titles; a filter or a window beside
   * it would be read as narrowing an answer it does not narrow. Only `space`
   * carries over.
   */
  private function refuseBesideTitle(Request $request): void {
    foreach (['type', 'author', 'updated', 'page'] as $name) {
      if (trim((string) $request->query->get($name, '')) !== '') {
        throw new UnprocessableEntityHttpException(sprintf('A title prefix is narrowed by its space alone, not by %s.', $name));
      }
    }
  }

  /**
   * The pages a title prefix offers, closest title first.
   *
   * @param string $title
   *   The words typed so far.
   * @param \Drupal\openkb_space\SpaceInterface|null $space
   *   The space to narrow to, or NULL for every space the caller may read.
   *
   * @return list<array<string, mixed>>
   *   The rows.
   */
  private function titlePages(string $title, ?SpaceInterface $space): array {
    try {
      $window = $this->titleWindow($title, ['space' => $space?->label() ?? '']);
    }
    catch (SearchApiException $e) {
      // The index could not be queried: unavailability, not "no matches". The
      // detail stays in the log — it names infrastructure.
      Error::logException($this->logger, $e);
      throw new ServiceUnavailableHttpException(NULL, 'Search is unavailable.');
    }
    $rows = [];
    foreach (array_slice($window->pages, 0, self::TITLE_PAGES) as $page) {
      $best = $page->best();
      $rows[] = [
        // The id every other surface names a page by: the search_api item id.
        'id' => $best->entityId,
        'title' => $best->title,
        'path' => $best->path,
        'space' => $best->space,
        'type' => $best->type,
        // The title with the matched words between the provider's mark
        // characters, for a caller that shows what the prefix reached.
        'highlights' => $best->highlights,
      ];
    }
    return $rows;
  }

  /**
   * Fetches until the offer list is full, or the index runs out.
   *
   * @param string $title
   *   The words typed so far.
   * @param array<string, mixed> $options
   *   What to narrow by, as the retrieval reads it.
   */
  private function titleWindow(string $title, array $options): PageWindow {
    $topK = self::TITLE_CHUNKS;
    while (TRUE) {
      $window = $this->retrieval->retrieveTitlePages($title, $topK, $options);
      if (count($window->pages) >= self::TITLE_PAGES || $window->chunks < $topK || $topK >= self::MAX_CHUNKS) {
        return $window;
      }
      $topK = min(self::MAX_CHUNKS, $topK * 2);
    }
  }

  /**
   * The window asked for, as a zero-based number the arm can reach.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   * @param int $lastPage
   *   The deepest window the answering arm pages to.
   */
  private function page(Request $request, int $lastPage): int {
    $raw = (string) $request->query->get('page', '0');
    if ($raw === '') {
      return 0;
    }
    if (preg_match('/^\d+$/', $raw) !== 1 || (int) $raw > $lastPage) {
      throw new UnprocessableEntityHttpException(sprintf('A page is a whole number from 0 to %d.', $lastPage));
    }
    return (int) $raw;
  }

  /**
   * The space slug the URL carries, '' where it carries none.
   */
  private function slug(Request $request): string {
    $slug = trim((string) $request->query->get('space', ''));
    if ($slug !== '' && preg_match(self::SLUG_PATTERN, $slug) !== 1) {
      throw new UnprocessableEntityHttpException('A space is named by its URL slug.');
    }
    return $slug;
  }

  /**
   * The space a slug names, NULL where it names none.
   */
  private function spaceBySlug(string $slug): ?SpaceInterface {
    return SpaceStorage::get($this->entityTypeManager)->getBySlug($slug);
  }

  /**
   * The document type the URL names, or '' for every type.
   *
   * An unknown one is the request being wrong rather than a search that
   * matches nothing: every value is published in the frontmatter schema.
   */
  private function type(Request $request): string {
    $type = trim((string) $request->query->get('type', ''));
    if ($type !== '' && !$this->types->has($type)) {
      throw new UnprocessableEntityHttpException('A type is one of the frontmatter schema\'s document types.');
    }
    return $type;
  }

  /**
   * The author the URL names, by user name, or '' for anyone.
   *
   * A name nobody holds narrows to nothing, the way a slug naming no space
   * does; only a name no account could carry is the request being wrong.
   */
  private function author(Request $request): string {
    $author = trim((string) $request->query->get('author', ''));
    if (mb_strlen($author) > self::MAX_AUTHOR_LENGTH) {
      throw new UnprocessableEntityHttpException(sprintf('An author is named by their user name, at most %d characters.', self::MAX_AUTHOR_LENGTH));
    }
    return $author;
  }

  /**
   * How far back the `updated` range reaches, as a timestamp, or NULL for any.
   *
   * The ranges are a closed set, so one the URL invents is the request being
   * wrong rather than a window that happens to hold nothing.
   */
  private function changedSince(Request $request): ?int {
    $range = trim((string) $request->query->get('updated', ''));
    if ($range === '') {
      return NULL;
    }
    if (!isset(self::UPDATED_RANGES[$range])) {
      throw new UnprocessableEntityHttpException(sprintf('An update range is one of %s.', implode(', ', array_keys(self::UPDATED_RANGES))));
    }
    return $this->time->getRequestTime() - self::UPDATED_RANGES[$range];
  }

  /**
   * The deepest window {@see self::MAX_CHUNKS} can still be asked to fill.
   */
  private function lastPage(): int {
    return intdiv(self::MAX_CHUNKS, self::PAGE_SIZE * self::CHUNKS_PER_PAGE) - 1;
  }

  /**
   * Fetches until the window asked for is filled, or the index runs out.
   *
   * How many chunks a page matches with is not known before the fetch, so a
   * window sized on an average can collapse to too few pages.
   *
   * @param string $query
   *   The query to run.
   * @param int $page
   *   The zero-based window asked for.
   * @param array<string, mixed> $options
   *   What to narrow by, as the retrieval reads it; an empty value narrows
   *   nothing.
   */
  private function window(string $query, int $page, array $options): PageWindow {
    // One page past the window tells the caller a further window exists.
    $wanted = ($page + 1) * self::PAGE_SIZE + 1;
    $topK = min(self::MAX_CHUNKS, $wanted * self::CHUNKS_PER_PAGE);
    while (TRUE) {
      $window = $this->retrieval->retrievePages($query, $topK, $options);
      if (count($window->pages) >= $wanted || $window->chunks < $topK || $topK >= self::MAX_CHUNKS) {
        return $window;
      }
      $topK = min(self::MAX_CHUNKS, $topK * 2);
    }
  }

  /**
   * The response body: one window of pages, and whether another follows.
   *
   * @param string $query
   *   The query that was run.
   * @param int $page
   *   The zero-based window asked for.
   * @param list<array<string, mixed>> $pages
   *   The rows of this window.
   * @param bool $hasMore
   *   Whether a further window follows this one.
   * @param int|null $total
   *   How many pages there are, NULL where only the window is known.
   *
   * @return array<string, mixed>
   *   The body.
   */
  private function answer(string $query, int $page, array $pages, bool $hasMore, ?int $total): array {
    return [
      'query' => $query,
      'page' => $page,
      'page_size' => self::PAGE_SIZE,
      'total' => $total,
      'has_more' => $hasMore,
      'pages' => $pages,
    ];
  }

  /**
   * One collapsed page as the response contract.
   *
   * @return array<string, mixed>
   *   The page.
   */
  private function toPage(PageHit $hit): array {
    $best = $hit->best();
    return [
      'id' => $best->entityId,
      'title' => $best->title,
      'path' => $best->path,
      'space' => $best->space,
      'type' => $best->type,
      'tags' => $best->tags,
      'changed' => $best->changed,
      'score' => $hit->score(),
      'sections' => array_map($this->toSection(...), $hit->sections),
    ];
  }

  /**
   * One listed page, in the row shape a matched page answers in.
   *
   * Nothing was ranked and nothing matched, so the row carries no score and
   * points at no section — it links the page itself.
   *
   * @return array<string, mixed>
   *   The page.
   */
  private function toListedPage(NodeInterface $node): array {
    $space = $node->get('field_space')->entity;
    return [
      // The id every other surface names a page by: the search_api item id.
      'id' => sprintf('entity:node/%d:%s', $node->id(), $node->language()->getId()),
      'title' => $node->label(),
      // The alias manager answers from the system path, so nothing is loaded
      // that the listing has not loaded already.
      'path' => $this->aliasManager->getAliasByPath('/node/' . $node->id()),
      'space' => $space instanceof SpaceInterface ? $space->label() : '',
      // The frontmatter a row shows, read as the index carries it: the type's
      // machine name, the tags by name.
      'type' => (string) $node->get('field_type')->value,
      'tags' => array_map(
        static fn (EntityInterface $tag): string => (string) $tag->label(),
        $node->get('field_tags')->referencedEntities(),
      ),
      'changed' => $node->getChangedTime(),
      'score' => 0.0,
      'sections' => [],
    ];
  }

  /**
   * One matching section of a page.
   *
   * @return array<string, mixed>
   *   The section.
   */
  private function toSection(ChunkHit $section): array {
    return [
      'block_id' => $section->blockId,
      'heading_path' => $section->headingPath,
      'excerpt' => $section->prose(),
      // The passages the lexical clause matched in, each matched word between
      // the provider's mark characters. Empty where the vector clause alone
      // found the section.
      'highlights' => $section->highlights,
      'score' => $section->score,
      'path' => $section->anchoredPath(),
    ];
  }

}
