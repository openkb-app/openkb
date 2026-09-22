<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access\Plugin\search_api\processor;

use Drupal\Core\Cache\RefinableCacheableDependencyInterface;
use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\Core\Session\AccountProxyInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\openkb_space_access\SpaceAccessMap;
use Drupal\search_api\Attribute\SearchApiProcessor;
use Drupal\search_api\IndexInterface;
use Drupal\search_api\Processor\ProcessorPluginBase;
use Drupal\search_api\Query\QueryInterface;
use Psr\Container\ContainerInterface;

/**
 * Filters a query in Drupal to the spaces the current account may read.
 *
 * One index, one read path, one access rule (ADR 0010): every search runs in
 * Drupal, and this is where the account's spaces narrow it.
 */
#[SearchApiProcessor(
  id: 'space_access_filter',
  label: new TranslatableMarkup('Space access filter'),
  description: new TranslatableMarkup('Filters queries run in Drupal to the spaces the account may read.'),
  stages: [
    'preprocess_query' => -30,
  ],
)]
final class SpaceAccessFilter extends ProcessorPluginBase implements ContainerFactoryPluginInterface {

  /**
   * The index field carrying the space a document belongs to.
   */
  private const SPACE_FIELD = 'space';

  public function __construct(
    array $configuration,
    $plugin_id,
    $plugin_definition,
    protected SpaceAccessMap $accessMap,
    protected AccountProxyInterface $currentUser,
  ) {
    parent::__construct($configuration, $plugin_id, $plugin_definition);
  }

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): self {
    return new self(
      $configuration,
      $plugin_id,
      $plugin_definition,
      $container->get(SpaceAccessMap::class),
      $container->get('current_user'),
    );
  }

  /**
   * {@inheritdoc}
   */
  public static function supportsIndex(IndexInterface $index): bool {
    return $index->getField(self::SPACE_FIELD) !== NULL;
  }

  /**
   * {@inheritdoc}
   *
   * Fail-closed: no readable space aborts the query instead of running it
   * unfiltered, and `search_api_bypass_access` is ignored — an option that
   * widens a read boundary is a way around it. Queries at `PROCESSING_NONE`
   * run no processor at all, so this holds at the default processing level.
   */
  public function preprocessSearchQuery(QueryInterface $query): void {
    // The answer is the current account's, whichever branch below it takes.
    if ($query instanceof RefinableCacheableDependencyInterface) {
      $query->addCacheContexts(['user']);
    }

    if ($query->getIndex()->getField(self::SPACE_FIELD) === NULL) {
      $query->abort('The space access filter has no space field to filter on.');
      return;
    }

    $readable = array_column($this->accessMap->list($this->currentUser->getAccount()), 'name');
    if (!$readable) {
      $query->abort('The account may read no space.');
      return;
    }

    $query->addCondition(self::SPACE_FIELD, $readable, 'IN');
  }

}
