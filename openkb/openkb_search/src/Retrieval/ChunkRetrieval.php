<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Retrieval;

use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\ai\AiProviderPluginManager;
use Drupal\ai\Exception\AiUnsafePromptException;
use Drupal\ai\OperationType\Embeddings\EmbeddingsInput;
use Drupal\search_api\IndexInterface;
use Drupal\search_api\Item\ItemInterface;
use Drupal\search_api\Query\QueryInterface;
use Drupal\search_api\SearchApiException;

/**
 * Retrieves chunks from the `kb_chunks` index through Search API.
 *
 * `search_api_bypass_access` keeps ai_search from loading entities;
 * `space_access_filter` ignores that option and still scopes the query.
 * `search_api_ai_get_chunks_result` answers one row per chunk, not per page.
 */
class ChunkRetrieval implements ChunkRetrievalInterface {

  /**
   * The floor the shipped configuration carries, on the vector clause's scale.
   */
  protected const DEFAULT_VECTOR_FLOOR = 0.75;

  /**
   * The attribute carrying a page's title, analyzed, on every chunk of it.
   */
  protected const TITLE_FIELD = 'title';

  public function __construct(
    protected EntityTypeManagerInterface $entityTypeManager,
    protected ConfigFactoryInterface $configFactory,
    protected AiProviderPluginManager $aiProvider,
  ) {}

  /**
   * {@inheritdoc}
   */
  public function retrieve(string $query, int $topK, array $options = []): array {
    $index = $this->index();
    $search = $index->query(['limit' => max(1, $topK)]);
    $search->setOption('search_api_bypass_access', TRUE);
    $search->setOption('search_api_ai_get_chunks_result', TRUE);
    // The relevance gate sits on the vector clause, where the score still
    // measures distance. The lexical clause gates itself: it answers only
    // rows carrying every word of the query.
    $search->setOption('vector_min_score', $this->vectorFloor());
    $search->keys($query);
    $search->setOption('vector_input', $this->queryVector($index, $this->embeddedText($search, $query)));
    $this->applyOptions($search, $options);

    $hits = [];
    foreach ($search->execute()->getResultItems() as $item) {
      $hits[] = $this->toHit($item);
    }
    return $hits;
  }

  /**
   * {@inheritdoc}
   */
  public function retrieveTitlePages(string $prefix, int $topK, array $options = []): PageWindow {
    $search = $this->index()->query(['limit' => max(1, $topK)]);
    $search->setOption('search_api_bypass_access', TRUE);
    $search->setOption('search_api_ai_get_chunks_result', TRUE);
    // The lexical arm alone, on the title: no vector is compared, so the
    // provider embeds nothing. `bool_prefix` is what lets the word still
    // being typed match the title word it starts.
    $search->setOption('lexical_only', ['type' => 'bool_prefix', 'fields' => [self::TITLE_FIELD]]);
    $search->keys($prefix);
    $this->applyOptions($search, $options);

    $hits = [];
    foreach ($search->execute()->getResultItems() as $item) {
      // The title is what matched, so the title is what carries the marks.
      $hits[] = $this->toHit($item, self::TITLE_FIELD);
    }
    return $this->closestTitleFirst($this->collapse($hits), $prefix);
  }

  /**
   * The offers, closest title first.
   *
   * A prefix matches every title carrying it and the lexical score ranks
   * those alike, so a title that merely says more can lead the one being
   * typed. What a picker offers first is the title the typed words fill: the
   * one they spell, then the shortest carrying them, then what ranked best.
   *
   * Shortest is by character count: a title is read, and the shorter of two
   * that carry the same words is the one that says less around them.
   *
   * @param \Drupal\openkb_search\Retrieval\PageWindow $window
   *   The offers, as the index ranked them.
   * @param string $prefix
   *   The words typed so far.
   */
  protected function closestTitleFirst(PageWindow $window, string $prefix): PageWindow {
    $typed = mb_strtolower(trim($prefix));
    $ranked = [];
    foreach ($window->pages as $rank => $page) {
      $title = $page->best()->title;
      $ranked[] = [[mb_strtolower($title) === $typed ? 0 : 1, mb_strlen($title), $rank], $page];
    }
    usort($ranked, static fn (array $a, array $b) => $a[0] <=> $b[0]);
    return new PageWindow(array_column($ranked, 1), $window->chunks);
  }

  /**
   * {@inheritdoc}
   */
  public function retrievePages(string $query, int $topK, array $options = []): PageWindow {
    return $this->collapse($this->retrieve($query, $topK, $options));
  }

  /**
   * One hit per page, ranked by the best section of each.
   *
   * @param list<\Drupal\openkb_search\Retrieval\ChunkHit> $hits
   *   The hits, best first.
   */
  protected function collapse(array $hits): PageWindow {
    $pages = [];
    foreach ($hits as $index => $hit) {
      // A hit naming no page is a page of its own rather than one bucket
      // every such hit falls into.
      $page = $hit->entityId === '' ? 'hit:' . $index : 'page:' . $hit->entityId;
      // An oversized block is chunked into parts that share a block id, so
      // several of them are one section, reached by one anchor. The best part
      // is the section; the rest would be duplicate links.
      $section = $hit->blockId === '' ? 'part:' . $hit->part : 'block:' . $hit->blockId;
      $pages[$page][$section] ??= $hit;
    }
    // Hits arrive best first, so both orders are already right: the pages by
    // the section that opened each bucket, the sections within a page by score.
    return new PageWindow(
      array_values(array_map(
        static fn (array $sections) => new PageHit(array_values($sections)),
        $pages,
      )),
      count($hits),
    );
  }

  /**
   * The query as a vector of the dimension the collection holds.
   *
   * Left to ai_search a query is embedded at the model's default dimension,
   * which a narrower collection cannot compare against. The server's own
   * number is also what the embedding cache keys on at index time.
   *
   * @param \Drupal\search_api\IndexInterface $index
   *   The index being queried.
   * @param string $query
   *   The natural-language query.
   *
   * @return list<float>
   *   The vector.
   */
  protected function queryVector(IndexInterface $index, string $query): array {
    $backend = $index->getServerInstance()?->getBackendConfig() ?? [];
    $engine = explode('__', (string) ($backend['embeddings_engine'] ?? ''), 2);
    if (count($engine) !== 2 || $engine[0] === '') {
      throw new SearchApiException(sprintf('The server of index "%s" names no embeddings engine.', $index->id()));
    }

    [$providerId, $modelId] = $engine;
    $configuration = $backend['embeddings_engine_configuration'] ?? [];
    $dimensions = (int) ($configuration['dimensions'] ?? 0);
    try {
      $provider = $this->aiProvider->createInstance($providerId);
      if (!empty($configuration['set_dimensions']) && $dimensions > 0) {
        $provider->setConfiguration(['dimensions' => $dimensions]);
      }
      return $provider->embeddings(new EmbeddingsInput($query, NULL), $modelId)->getNormalized();
    }
    catch (AiUnsafePromptException $e) {
      // The guard read the caller's own words and refused them. Nothing is
      // wrong with the index, and the same words will be refused again.
      throw new QueryRefusedException('The query was refused by the provider\'s content guard.', 0, $e);
    }
    catch (\Throwable $e) {
      // An unkeyed or failing embeddings provider is the index being
      // unreachable, not a query that matched nothing. Every consumer already
      // reads a SearchApiException as unavailability, so it is raised here
      // rather than left to escape from a place none of them watch.
      throw new SearchApiException(sprintf('The query could not be embedded through "%s".', $providerId), 0, $e);
    }
  }

  /**
   * The query as the vector arm asks it: the keys it is not to exclude.
   *
   * An excluded key bounds both arms as a filter. Embedded it would do the
   * opposite and pull the rows carrying it nearer.
   *
   * @param \Drupal\search_api\Query\QueryInterface $search
   *   The query, its keys already parsed.
   * @param string $query
   *   The words the caller asked with.
   *
   * @return string
   *   The text to embed.
   */
  protected function embeddedText(QueryInterface $search, string $query): string {
    $keys = $search->getKeys();
    if (!is_array($keys)) {
      return $query;
    }
    $text = implode(' ', $this->includedKeys($keys));
    // A query that is nothing but an exclusion has no words of its own left;
    // the filter still takes the rows it names out of what the arm answers.
    return $text === '' ? $query : $text;
  }

  /**
   * The keys of a parsed group that are not excluded, nested ones included.
   *
   * @param array $keys
   *   A parsed key group.
   *
   * @return list<string>
   *   The keys.
   */
  protected function includedKeys(array $keys): array {
    if (!empty($keys['#negation'])) {
      return [];
    }
    $included = [];
    foreach ($keys as $key => $value) {
      if (is_string($key) && str_starts_with($key, '#')) {
        continue;
      }
      $included = is_array($value)
        ? [...$included, ...$this->includedKeys($value)]
        : [...$included, (string) $value];
    }
    return $included;
  }

  /**
   * The score a section must reach on the vector clause.
   */
  protected function vectorFloor(): float {
    // A missing key would take the floor off altogether, which answers the
    // nearest row to any question.
    return (float) ($this->configFactory->get('openkb_search.settings')->get('vector_floor') ?? self::DEFAULT_VECTOR_FLOOR);
  }

  /**
   * The chunk index named in openkb_search.settings.
   */
  protected function index(): IndexInterface {
    $id = (string) $this->configFactory->get('openkb_search.settings')->get('chunk_index');
    $index = $this->entityTypeManager->getStorage('search_api_index')->load($id);
    if (!$index instanceof IndexInterface) {
      throw new SearchApiException(sprintf('The chunk index "%s" does not exist.', $id));
    }
    return $index;
  }

  /**
   * Narrows the query as the options ask; each option names an index field.
   *
   * A keyword attribute narrows to the value given, a date attribute to the
   * rows at or after it. Every such attribute the index carries is reachable
   * this way, so a field added to `field_settings` is filterable without a
   * change here. An option naming no such field is a caller's mistake, not a
   * narrowing that quietly does nothing.
   *
   * @param \Drupal\search_api\Query\QueryInterface $search
   *   The query to narrow.
   * @param array<string, mixed> $options
   *   The options, as retrieve() documents them.
   */
  protected function applyOptions(QueryInterface $search, array $options): void {
    $fields = $search->getIndex()->getFields();
    foreach ($options as $name => $value) {
      if ($value === '' || $value === NULL) {
        continue;
      }
      match (($fields[$name] ?? NULL)?->getType()) {
        'string' => $search->addCondition($name, (string) $value),
        'date' => $search->addCondition($name, (int) $value, '>='),
        default => throw new \InvalidArgumentException(sprintf('"%s" is no attribute of the chunk index a search narrows by.', $name)),
      };
    }
  }

  /**
   * One chunk row as a hit.
   *
   * The ai_search backend builds a result item out of the row and nothing
   * else: it sets the score and one extra-data key per `_source` field, the
   * item's attributes and the chunk's own metadata alike, and leaves the
   * item's fields empty. Reading a field would extract it, which loads the
   * entity behind the id and fails outright on a chunked one.
   */
  protected function toHit(ItemInterface $item, string $highlightField = 'content'): ChunkHit {
    $headingPath = $item->getExtraData('heading_path') ?? [];
    $headingPath = is_array($headingPath) ? array_values(array_map('strval', $headingPath)) : [];
    return new ChunkHit(
      entityId: $this->attribute($item, 'drupal_entity_id'),
      blockId: $this->attribute($item, 'block_id'),
      title: $this->attribute($item, 'title'),
      path: $this->attribute($item, 'path'),
      space: $this->attribute($item, 'space'),
      score: (float) $item->getScore(),
      excerpt: $this->attribute($item, 'content'),
      headingPath: $headingPath,
      part: (int) ($item->getExtraData('part') ?? 0),
      langcode: $this->attribute($item, 'langcode'),
      changed: (int) $this->attribute($item, 'changed'),
      highlights: $this->highlights($item, $highlightField),
      type: $this->attribute($item, 'type'),
      tags: $this->attributes($item, 'tags'),
      cites: $this->attributes($item, 'cites'),
    );
  }

  /**
   * The marked fragments of the field the lexical clause matched, best first.
   *
   * @param \Drupal\search_api\Item\ItemInterface $item
   *   The result item.
   * @param string $field
   *   The text field whose fragments a caller shows.
   *
   * @return list<string>
   *   The fragments, empty where the lexical clause did not match the row.
   */
  private function highlights(ItemInterface $item, string $field): array {
    $highlight = $item->getExtraData('highlight');
    $fragments = is_array($highlight) ? ($highlight[$field] ?? []) : [];
    return is_array($fragments) ? array_values(array_map('strval', $fragments)) : [];
  }

  /**
   * One stored value of the row, as a string.
   */
  private function attribute(ItemInterface $item, string $key): string {
    $value = $item->getExtraData($key);
    if (is_array($value)) {
      $value = reset($value);
    }
    return is_scalar($value) ? (string) $value : '';
  }

  /**
   * Every stored value of a multi-value attribute, as strings.
   *
   * A row carrying one value holds it unwrapped, and a page that left the
   * field empty holds an empty string rather than nothing.
   *
   * @return list<string>
   *   The values.
   */
  private function attributes(ItemInterface $item, string $key): array {
    $value = $item->getExtraData($key);
    $values = is_array($value) ? $value : [$value];
    return array_values(array_filter(
      array_map(static fn (mixed $one) => is_scalar($one) ? (string) $one : '', $values),
      static fn (string $one) => $one !== '',
    ));
  }

}
