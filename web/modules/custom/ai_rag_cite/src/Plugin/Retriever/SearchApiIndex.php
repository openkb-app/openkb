<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite\Plugin\Retriever;

use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityMalformedException;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Entity\Exception\UndefinedLinkTemplateException;
use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\ai_rag_cite\Attribute\Retriever;
use Drupal\ai_rag_cite\RetrieverBase;
use Drupal\ai_rag_cite\RetrieverException;
use Drupal\ai_rag_cite\ValueObject\Source;
use Drupal\path_alias\AliasManagerInterface;
use Drupal\search_api\IndexInterface;
use Drupal\search_api\Item\ItemInterface;
use Drupal\search_api\ParseMode\ParseModePluginManager;
use Drupal\search_api\SearchApiException;
use Drupal\search_api\Utility\FieldsHelperInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Retrieves from a Search API index.
 *
 * - A question is read as a fulltext search: its words rank the pages.
 * - Access comes from the index's own processors, so the query adds no filter.
 * - Sources are read off the page, not the index: indexed text is stemmed.
 * - A hit with no page, or no address to cite, is dropped.
 */
#[Retriever(
  id: 'search_api_index',
  label: new TranslatableMarkup('Search API index'),
  description: new TranslatableMarkup('Runs the question as a query on a Search API index.'),
)]
class SearchApiIndex extends RetrieverBase implements ContainerFactoryPluginInterface {

  /**
   * How much of a passage the model is shown.
   */
  private const EXCERPT_LENGTH = 400;

  /**
   * Constructs the plugin.
   *
   * @param array $configuration
   *   The plugin configuration.
   * @param string $plugin_id
   *   The plugin id.
   * @param mixed $plugin_definition
   *   The plugin definition.
   * @param \Drupal\Core\Entity\EntityTypeManagerInterface $entityTypeManager
   *   Loads the index.
   * @param \Drupal\search_api\Utility\FieldsHelperInterface $fieldsHelper
   *   Reads a hit's fields off the page rather than off the index.
   * @param \Drupal\search_api\ParseMode\ParseModePluginManager $parseModeManager
   *   Builds the parse mode the question is read with.
   * @param \Drupal\path_alias\AliasManagerInterface $aliasManager
   *   Reads the alias a cited page is read at.
   */
  public function __construct(
    array $configuration,
    string $plugin_id,
    mixed $plugin_definition,
    protected EntityTypeManagerInterface $entityTypeManager,
    protected FieldsHelperInterface $fieldsHelper,
    protected ParseModePluginManager $parseModeManager,
    protected AliasManagerInterface $aliasManager,
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
      $container->get('entity_type.manager'),
      $container->get('search_api.fields_helper'),
      $container->get('plugin.manager.search_api.parse_mode'),
      $container->get('path_alias.manager'),
    );
  }

  /**
   * {@inheritdoc}
   */
  public function defaultConfiguration(): array {
    return [
      'index' => '',
      'top_k' => 10,
      'meta_field' => '',
      'excerpt_field' => '',
    ];
  }

  /**
   * {@inheritdoc}
   *
   * The index is queried the same way whatever the caller context holds; this
   * retriever narrows by nothing but the question.
   */
  public function retrieve(string $query, array $context = []): array {
    $index = $this->entityTypeManager->getStorage('search_api_index')
      ->load((string) $this->configuration['index']);
    if (!$index instanceof IndexInterface) {
      throw new RetrieverException(sprintf('Index "%s" does not exist.', $this->configuration['index']));
    }

    $search = $index->query(['limit' => max(1, (int) $this->configuration['top_k'])]);
    // A question is a fulltext search: its words rank the pages, and the score
    // gate above this keeps the weak hits out.
    $search->setParseMode(
      $this->parseModeManager->createInstance('terms')->setConjunction('OR'),
    );
    $search->keys($query);
    try {
      $results = $search->execute();
    }
    catch (SearchApiException $e) {
      throw new RetrieverException(sprintf('Index "%s" could not be queried.', $index->id()), 0, $e);
    }

    $items = $results->getResultItems();
    $objects = $index->loadItemsMultiple(array_keys($items));

    $sources = [];
    foreach ($items as $id => $item) {
      $object = $objects[$id] ?? NULL;
      $entity = $object?->getValue();
      if (!$entity instanceof EntityInterface) {
        continue;
      }
      $path = $this->path($entity);
      if ($path === NULL) {
        continue;
      }
      $sources[] = $this->toSource(
        $this->fieldsHelper->createItemFromObject($index, $object, $id),
        $entity,
        $path,
        $item->getScore(),
      );
    }
    return $sources;
  }

  /**
   * One hit as a source, read off the page it names.
   *
   * @param \Drupal\search_api\Item\ItemInterface $item
   *   The hit's fields, extracted from the page.
   * @param \Drupal\Core\Entity\EntityInterface $entity
   *   The page.
   * @param string $path
   *   Where the page is read.
   * @param float $score
   *   How well the page matched.
   */
  private function toSource(ItemInterface $item, EntityInterface $entity, string $path, float $score): Source {
    return new Source(
      entityId: $entity->getEntityTypeId() . ':' . $entity->id(),
      title: (string) $entity->label(),
      path: $path,
      meta: $this->firstValue($item, (string) $this->configuration['meta_field']),
      excerpt: $this->excerpt($this->firstValue($item, (string) $this->configuration['excerpt_field'])),
      score: $score,
    );
  }

  /**
   * Where a page is read, or NULL when it has no address to be cited by.
   *
   * An entity type without a canonical route is not citable. The client routes
   * the value as a site-root path, so the page's alias is cited.
   */
  private function path(EntityInterface $entity): ?string {
    try {
      $internal = '/' . $entity->toUrl('canonical')->getInternalPath();
    }
    catch (UndefinedLinkTemplateException | EntityMalformedException | \UnexpectedValueException) {
      return NULL;
    }
    return $this->aliasManager->getAliasByPath($internal, $entity->language()->getId());
  }

  /**
   * The first indexed value of a field, as a string.
   */
  private function firstValue(ItemInterface $item, string $field): string {
    if ($field === '') {
      return '';
    }
    $values = $item->getField($field)?->getValues() ?? [];
    return isset($values[0]) ? (string) $values[0] : '';
  }

  /**
   * The opening of a passage, as much of it as the model is shown.
   *
   * Markup is dropped: an index field is often rendered HTML, and tags spend
   * the model's context without adding to what it can ground a claim on.
   */
  private function excerpt(string $text): string {
    $trimmed = trim((string) preg_replace('/\s+/u', ' ', strip_tags($text)));
    return mb_strlen($trimmed) <= self::EXCERPT_LENGTH
      ? $trimmed
      : mb_substr($trimmed, 0, self::EXCERPT_LENGTH) . '…';
  }

}
