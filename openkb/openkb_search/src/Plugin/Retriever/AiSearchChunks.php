<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Plugin\Retriever;

use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\ai_rag_cite\Attribute\Retriever;
use Drupal\ai_rag_cite\RetrieverBase;
use Drupal\ai_rag_cite\RetrieverException;
use Drupal\ai_rag_cite\ValueObject\Source;
use Drupal\openkb_search\Retrieval\ChunkHit;
use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Drupal\openkb_space\SpaceStorage;
use Drupal\search_api\SearchApiException;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Grounds an answer on the chunk index, one source per section.
 *
 * The chat and the `search_pages` tool retrieve through the same service, so
 * neither is answered a section the other would not get. A source is the
 * section's own text, cited at the block it opens on.
 *
 * The turn's caller context decides how wide the retrieval is. Two keys, both
 * naming a space by its URL slug, as every other client-facing surface does:
 *
 * - `scope` — what the reader picked. A slug narrows to that space; `all`, or
 *   nothing, retrieves from every space the account may read.
 * - `space` — the space the open page lives in. Under `all` it lifts that
 *   space in the ranking instead of narrowing to it, so an answer one space
 *   over stays reachable.
 */
#[Retriever(
  id: 'ai_search_chunks',
  label: new TranslatableMarkup('OpenKB chunk index'),
  description: new TranslatableMarkup('Retrieves sections from the chunk index, each cited at the block it opens on.'),
)]
final class AiSearchChunks extends RetrieverBase implements ContainerFactoryPluginInterface {

  /**
   * The scope value that names every space the account may read.
   */
  private const SCOPE_ALL = 'all';

  /**
   * How far a section of the open page's space is lifted in the ranking.
   *
   * On the band the index scores in, 15% is enough to put a clearly weaker
   * local section ahead of a stronger one from another space. The gate cuts
   * the order this leaves, so the lift decides which sources ground the
   * answer; the score a section is reported with is still the index's.
   */
  private const PAGE_SPACE_BIAS = 0.15;

  /**
   * Constructs the plugin.
   *
   * @param array $configuration
   *   The plugin configuration.
   * @param string $plugin_id
   *   The plugin id.
   * @param mixed $plugin_definition
   *   The plugin definition.
   * @param \Drupal\openkb_search\Retrieval\ChunkRetrievalInterface $retrieval
   *   The read path both AI consumers share.
   * @param \Drupal\Core\Entity\EntityTypeManagerInterface $entityTypeManager
   *   Resolves the slug a turn names to the space's label.
   */
  public function __construct(
    array $configuration,
    string $plugin_id,
    mixed $plugin_definition,
    protected ChunkRetrievalInterface $retrieval,
    protected EntityTypeManagerInterface $entityTypeManager,
  ) {
    parent::__construct($configuration, $plugin_id, $plugin_definition);
  }

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    return new static(
      $configuration,
      $plugin_id,
      $plugin_definition,
      $container->get(ChunkRetrievalInterface::class),
      $container->get('entity_type.manager'),
    );
  }

  /**
   * {@inheritdoc}
   */
  public function defaultConfiguration(): array {
    return [
      'top_k' => 10,
    ];
  }

  /**
   * {@inheritdoc}
   */
  public function retrieve(string $query, array $context = []): array {
    $narrowed = $this->narrowTo($context);
    try {
      $hits = $this->retrieval->retrieve(
        $query,
        max(1, (int) $this->configuration['top_k']),
        ['space' => $narrowed],
      );
    }
    catch (SearchApiException $e) {
      throw new RetrieverException('The chunk index could not be queried.', 0, $e);
    }
    // Only a turn that is not already narrowed has an order left to lift.
    $pageSpace = trim((string) ($context['space'] ?? ''));
    $preferred = $narrowed === '' ? ($this->label($pageSpace) ?? '') : '';
    return array_map($this->toSource(...), $this->prefer($hits, $preferred));
  }

  /**
   * The space label the turn is narrowed to, or '' for every readable space.
   *
   * @param array<string, mixed> $context
   *   The caller context.
   */
  private function narrowTo(array $context): string {
    $scope = trim((string) ($context['scope'] ?? ''));
    if ($scope === '' || $scope === self::SCOPE_ALL) {
      return '';
    }
    // A slug naming no space narrows to nothing rather than widening the turn
    // back out to every space.
    return $this->label($scope) ?? $scope;
  }

  /**
   * The label of the space a slug names, or NULL when it names none.
   */
  private function label(string $slug): ?string {
    return $slug === ''
      ? NULL
      : SpaceStorage::get($this->entityTypeManager)->getBySlug($slug)?->label();
  }

  /**
   * The hits reordered so one space's sections lead.
   *
   * The sort key is the score lifted by the bias; the hit keeps its own score,
   * so the grounding's gate measures what the index answered.
   *
   * @param list<\Drupal\openkb_search\Retrieval\ChunkHit> $hits
   *   The hits, best first.
   * @param string $space
   *   The preferred space's label, or '' to leave the order alone.
   *
   * @return list<\Drupal\openkb_search\Retrieval\ChunkHit>
   *   The hits, best first.
   */
  private function prefer(array $hits, string $space): array {
    if ($space === '') {
      return $hits;
    }
    $ranked = array_map(
      static fn (ChunkHit $hit, int $place) => [
        'hit' => $hit,
        'place' => $place,
        'rank' => $hit->score * ($hit->space === $space ? 1 + self::PAGE_SPACE_BIAS : 1),
      ],
      $hits,
      array_keys($hits),
    );
    // The index's own order decides a pair the lift leaves level.
    usort($ranked, static fn (array $a, array $b) => [$b['rank'], $a['place']] <=> [$a['rank'], $b['place']]);
    return array_column($ranked, 'hit');
  }

  /**
   * One chunk as a source: the page's title, the block's address, its text.
   *
   * Every kept section is offered as its own source. Sections of one page
   * share `entityId`, which is what the per-entity cap counts by. The section
   * carries the sources it was itself derived from, so an answer's chain of
   * provenance does not stop at the page it quotes.
   */
  private function toSource(ChunkHit $hit): Source {
    return new Source(
      entityId: $hit->entityId,
      title: $hit->title,
      path: $hit->anchoredPath(),
      meta: $hit->headingLine(),
      excerpt: $hit->prose(),
      score: $hit->score,
      cites: $hit->cites,
    );
  }

}
