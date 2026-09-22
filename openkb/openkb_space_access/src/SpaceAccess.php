<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access;

use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Session\AccessPolicyProcessorInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_space\SpaceStorage;

/**
 * The questions the hooks ask about space access.
 *
 * Everything routes through the `kb_space` access policy — this class only
 * translates between the policy's per-space permissions and the shapes Drupal's
 * access surfaces need: node grant ids, "may I see this space", "which spaces
 * are hidden from this account".
 *
 * ## The grants realm
 *
 * One realm, `kb_space`, with two grant ids per space derived from its id: an
 * even one for readers (`id * 2`) and the next odd one for editors
 * (`id * 2 + 1`). Editor grants carry view as well, so an editor never needs
 * both. Pages outside a space write no records and keep the default `all`
 * realm — the space is the access boundary, nothing else is.
 */
final class SpaceAccess {

  /**
   * The node access realm this module owns.
   */
  public const REALM = 'kb_space';

  public function __construct(
    private readonly AccessPolicyProcessorInterface $processor,
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * The grant id readers of a space hold.
   */
  public static function viewGid(int $id): int {
    return $id * 2;
  }

  /**
   * The grant id editors of a space hold.
   */
  public static function editGid(int $id): int {
    return $id * 2 + 1;
  }

  /**
   * The space ids in which the account holds a permission.
   *
   * @return int[]
   *   Space ids, in no particular order.
   */
  public function spaceIds(AccountInterface $account, string $permission): array {
    $ids = [];
    $calculated = $this->processor->processAccessPolicies($account, SpaceAccessPolicy::SCOPE);
    foreach ($calculated->getItemsByScope(SpaceAccessPolicy::SCOPE) as $item) {
      if ($item->isAdmin() || $item->hasPermission($permission)) {
        $ids[] = (int) $item->getIdentifier();
      }
    }
    return $ids;
  }

  /**
   * Whether the account holds a permission in one space.
   */
  public function hasPermission(AccountInterface $account, int $id, string $permission): bool {
    $calculated = $this->processor->processAccessPolicies($account, SpaceAccessPolicy::SCOPE);
    $item = $calculated->getItem(SpaceAccessPolicy::SCOPE, $id);
    return $item && ($item->isAdmin() || $item->hasPermission($permission));
  }

  /**
   * The space ids the account may not even see.
   *
   * Collections filter on this rather than on the visible set, so a site with
   * no private spaces adds no condition at all.
   *
   * @return int[]
   *   Ids of the spaces to hide.
   */
  public function hiddenSpaceIds(AccountInterface $account): array {
    $visible = array_flip($this->spaceIds($account, SpaceAccessPolicy::VIEW));
    $hidden = [];
    $storage = SpaceStorage::get($this->entityTypeManager);
    foreach (array_keys($storage->all()) as $id) {
      if (!isset($visible[(int) $id])) {
        $hidden[] = (int) $id;
      }
    }
    return $hidden;
  }

  /**
   * The id of the space an entity belongs to, if any.
   *
   * Pages carry `field_space`; a space is its own space, which is what lets
   * the routed-entity surfaces and the node hooks answer from the same policy.
   */
  public function spaceIdOf(EntityInterface $entity): ?int {
    if ($entity instanceof SpaceInterface) {
      return $entity->id() === NULL ? NULL : (int) $entity->id();
    }
    if (!$entity instanceof NodeInterface || !$entity->hasField('field_space')) {
      return NULL;
    }
    $id = $entity->get('field_space')->target_id;
    return $id === NULL ? NULL : (int) $id;
  }

  /**
   * The published page ids assigned to a space.
   *
   * @return int[]
   *   Node ids.
   */
  public function pageIds(int $id): array {
    $storage = $this->entityTypeManager->getStorage('node');
    $ids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('field_space', $id)
      ->execute();
    return array_map('intval', array_values($ids));
  }

}
