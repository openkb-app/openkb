<?php

declare(strict_types=1);

namespace Drupal\openkb_space;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Entity\EntityAccessControlHandler;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Session\AccountInterface;

/**
 * Access to a space is decided by its roster, read access and status.
 *
 * Managers update and restructure; the roster reads, or every signed-in user
 * when the space is open to all; a disabled space is seen by its managers
 * only; delete and every revision operation are the administrator's.
 *
 * `restructure` is the page tree's own operation. Holding it apart from
 * `update` is what lets a space that runs no review widen it to its writers
 * without handing them the space's settings — openkb_space_access does that.
 */
final class SpaceAccessControlHandler extends EntityAccessControlHandler {

  /**
   * {@inheritdoc}
   */
  protected function checkAccess(EntityInterface $entity, $operation, AccountInterface $account): AccessResult {
    assert($entity instanceof SpaceInterface);
    if ($account->hasPermission($this->entityType->getAdminPermission())) {
      return AccessResult::allowed()->cachePerPermissions();
    }
    $result = match ($operation) {
      'view' => AccessResult::allowedIf($entity->isPublished() ? $this->mayRead($entity, $account) : $entity->isOnRoster(SpaceInterface::MANAGERS, $account)),
      'update', 'restructure' => AccessResult::allowedIf($entity->isOnRoster(SpaceInterface::MANAGERS, $account)),
      default => AccessResult::neutral(),
    };
    return $result->cachePerPermissions()->cachePerUser()->addCacheableDependency($entity);
  }

  /**
   * {@inheritdoc}
   */
  protected function checkCreateAccess(AccountInterface $account, array $context, $entity_bundle = NULL): AccessResult {
    $permissions = ['create openkb_space', $this->entityType->getAdminPermission()];
    return AccessResult::allowedIfHasPermissions($account, $permissions, 'OR');
  }

  /**
   * Whether the account is on a roster, or the space is open to all users.
   */
  private function mayRead(SpaceInterface $space, AccountInterface $account): bool {
    if ($space->isOpenToAllUsers()) {
      return $account->isAuthenticated();
    }
    foreach ([SpaceInterface::MANAGERS, SpaceInterface::MEMBERS, SpaceInterface::VIEWERS] as $roster) {
      if ($space->isOnRoster($roster, $account)) {
        return TRUE;
      }
    }
    return FALSE;
  }

}
