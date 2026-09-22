<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access\Hook;

use Drupal\Core\Cache\CacheTagsInvalidatorInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Hook\Attribute\Hook;
use Drupal\openkb_space\SpaceInterface;
use Drupal\pathauto\PathautoGeneratorInterface;
use Drupal\search_api\Plugin\search_api\datasource\ContentEntityTrackingManager;

/**
 * Carries a space's pages along when its own URL moves.
 */
final class SpaceRenameHooks {

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly CacheTagsInvalidatorInterface $cacheTagsInvalidator,
    private readonly ?PathautoGeneratorInterface $aliasGenerator,
    private readonly ?ContentEntityTrackingManager $searchTracking,
  ) {}

  /**
   * Implements hook_ENTITY_TYPE_update() for openkb_space.
   *
   * A page's alias nests under its space's, and pathauto re-derives it only
   * when the page itself is saved. So the space carries its pages along when
   * its own URL moves; `redirect` keeps the old page URLs answering, and an
   * page with a hand-set alias keeps the one it was given.
   */
  #[Hook('openkb_space_update')]
  public function carryPages(SpaceInterface $space): void {
    // The name is the URL, and it is the only reading of the old one left: the
    // space's `path` is computed, and resolves after the save has already
    // rewritten the alias row. Which pages actually move is pathauto's
    // answer.
    $original = $space->getOriginal();
    if (!$original || $original->label() === $space->label() || !$this->aliasGenerator) {
      return;
    }
    $storage = $this->entityTypeManager->getStorage('node');
    $ids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('field_space', $space->id())
      ->execute();
    $tags = [];
    foreach (array_chunk($ids, 50) as $chunk) {
      foreach ($storage->loadMultiple($chunk) as $node) {
        if ($this->aliasGenerator->updateEntityAlias($node, 'update')) {
          // The page itself did not change, so nothing drops what is held of
          // it, and what is held names the old URL — caches and the search
          // index both. The index carries the path and the space name; both
          // moved.
          $tags[] = $node->getCacheTagsToInvalidate();
          $this->searchTracking?->entityUpdate($node);
        }
      }
      $storage->resetCache($chunk);
    }
    if ($tags) {
      $this->cacheTagsInvalidator->invalidateTags(array_merge(...$tags));
    }
  }

}
