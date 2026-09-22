<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Hook;

use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Hook\Attribute\Hook;
use Drupal\node\NodeInterface;
use Drupal\path_alias\PathAliasInterface;
use Drupal\search_api\Plugin\search_api\datasource\ContentEntityTrackingManager;

/**
 * Re-indexes a page when its alias moves.
 *
 * The indexes carry the alias as `path` ({@see \Drupal\comark\Plugin\search_api
 * \processor\KbPagePath}), because a hit has to be linkable without a
 * Drupal request. An alias saved on its own — a hand edit, a pathauto bulk run
 * — changes no node, so nothing else would tell the index the address moved.
 */
final class KbPageAliasHooks {

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly ContentEntityTrackingManager $searchTracking,
  ) {}

  /**
   * Implements hook_ENTITY_TYPE_insert() for path_alias.
   */
  #[Hook('path_alias_insert')]
  public function aliasInserted(PathAliasInterface $alias): void {
    $this->retrack($alias->getPath());
  }

  /**
   * Implements hook_ENTITY_TYPE_update() for path_alias.
   *
   * An alias can be moved from one node to another, which changes the address
   * of both: the one that lost it falls back to its system path.
   */
  #[Hook('path_alias_update')]
  public function aliasUpdated(PathAliasInterface $alias): void {
    $this->retrack($alias->getPath());
    $original = $alias->getOriginal()?->getPath();
    if ($original !== NULL && $original !== $alias->getPath()) {
      $this->retrack($original);
    }
  }

  /**
   * Implements hook_ENTITY_TYPE_delete() for path_alias.
   */
  #[Hook('path_alias_delete')]
  public function aliasDeleted(PathAliasInterface $alias): void {
    $this->retrack($alias->getPath());
  }

  /**
   * Marks the page a system path names for re-indexing.
   *
   * Which indexes take the node is the tracking manager's answer, so a node
   * of another bundle is not this class's to rule out.
   */
  private function retrack(string $path): void {
    if (!preg_match('#^/node/(\d+)$#', $path, $matches)) {
      return;
    }
    $node = $this->entityTypeManager->getStorage('node')->load((int) $matches[1]);
    if ($node instanceof NodeInterface) {
      $this->searchTracking->entityUpdate($node);
    }
  }

}
