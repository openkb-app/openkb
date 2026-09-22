<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access;

use Drupal\Core\Session\AccessPolicyBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\CalculatedPermissionsItem;
use Drupal\Core\Session\RefinableCalculatedPermissionsInterface;
use Drupal\openkb_space\SpaceInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\openkb_space\SpaceStorage;

/**
 * Calculates what an account may do in each space.
 *
 * One access policy in the `kb_space` scope is the single authority for space
 * access: the node-grants realm, the node hooks, the search filter and the
 * space's own access handler all read the permissions calculated here, so
 * read/write rules exist once.
 *
 * Per space, from its roster and read access:
 *   - `bypass node access` → admin in every space,
 *   - manager → view + update + publish + manage,
 *   - member  → view + update + publish,
 *   - viewer  → view,
 *   - anyone signed in, if read access is `all_users` → view,
 *   - anonymous → nothing, whatever the read access.
 *
 * A disabled space keeps only its managers, which is the line the space's own
 * access handler draws. Its pages fall out of every read surface with it —
 * the grants realm, the collections, the search filter — because they all read
 * from here.
 *
 * Ranks are checked most-privileged first, so the highest roster an account
 * sits on decides its permissions. `manage` is what separates a manager from a
 * member who also writes: it gates the space's own settings and roster (space
 * update, the frontend's `canManage`), which a plain writer does not get.
 *
 * `use collaboration api` is the collaboration server's way into every space:
 * it adds view + update there, on top of whatever the rosters gave. A floor,
 * not a rank — it never lowers the seat an account already has, and it says
 * nothing about who is believed about a checkpoint's writer sets.
 *
 * The bypass is keyed on `bypass node access` because that is the permission
 * that already makes every page visible whatever space it sits in. Keyed on
 * anything else the two drift, and a site administrator reads a page out of
 * a space that is missing from their own space list.
 *
 * The result is cached per user by the access policy processor and invalidated
 * by the spaces' own cache tags, so a roster or visibility save is picked up
 * without any explicit cache handling here — plus the entity type's list tag,
 * which is the only thing a space that does not exist yet can be described by.
 * Without it a calculation depends on the spaces it happened to read, and a
 * space created afterwards has no way to invalidate it: the account it puts on
 * its roster keeps answering out of a cache computed before the space existed,
 * and cannot reach it at all.
 */
final class SpaceAccessPolicy extends AccessPolicyBase {

  /**
   * The scope this policy calculates permissions in.
   */
  public const SCOPE = 'kb_space';

  /**
   * Read the space and its pages.
   */
  public const VIEW = 'view space content';

  /**
   * Write, move and delete the space's pages.
   */
  public const UPDATE = 'update space content';

  /**
   * Publish in the space.
   *
   * Held by a space's managers and members, and — like the other two — named by
   * an agent scope, which is the only thing that reads it: it is what keeps a
   * token capped at "owner ∩ scope ∩ space". Publishing itself is authorized by
   * update access on the page (see openkb_space_access.module), because
   * every publish runs through a surface that already requires it.
   */
  public const PUBLISH = 'publish space content';

  /**
   * Manage the space itself — its settings, roster and review policy.
   *
   * Held by a space's managers only, and the boundary that keeps a member (who
   * writes content) from touching the space's own configuration. It is what
   * the frontend reads as `canManage`. No agent scope names it: an agent
   * writes content, it never administers a space.
   */
  public const MANAGE = 'manage space';

  /**
   * The core permission that makes an account an admin in every space.
   */
  public const BYPASS = 'bypass node access';

  /**
   * The permission that writes in a space without sitting on its roster.
   *
   * Held by the collaboration server's own account (ADR 0001), which
   * checkpoints sessions in every space and is a member of none. It buys view
   * and update and stops there: a checkpoint that publishes does so as the
   * user who published and answers to their rights, and a space's own settings
   * are its managers'.
   */
  public const COLLABORATION = 'use collaboration api';

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * {@inheritdoc}
   */
  public function applies(string $scope): bool {
    return $scope === self::SCOPE;
  }

  /**
   * {@inheritdoc}
   */
  public function calculatePermissions(AccountInterface $account, string $scope): RefinableCalculatedPermissionsInterface {
    $calculated_permissions = parent::calculatePermissions($account, $scope);
    // Covers the spaces that do not exist yet — see the class docblock. Core
    // invalidates it on every space insert and delete.
    $calculated_permissions->addCacheTags(['openkb_space_list']);

    $is_admin = $account->hasPermission(self::BYPASS);
    $is_collaboration_server = $account->hasPermission(self::COLLABORATION);

    $storage = SpaceStorage::get($this->entityTypeManager);
    foreach ($storage->all() as $id => $space) {
      $calculated_permissions->addCacheableDependency($space);

      if ($is_admin) {
        $calculated_permissions->addItem(
          new CalculatedPermissionsItem([], TRUE, self::SCOPE, (int) $id),
        );
        continue;
      }

      $is_manager = $space->isOnRoster(SpaceInterface::MANAGERS, $account);
      $permissions = [];
      if ($is_manager) {
        $permissions = [self::VIEW, self::UPDATE, self::PUBLISH, self::MANAGE];
      }
      elseif ($space->isOnRoster(SpaceInterface::MEMBERS, $account)) {
        $permissions = [self::VIEW, self::UPDATE, self::PUBLISH];
      }
      elseif ($space->isOnRoster(SpaceInterface::VIEWERS, $account)) {
        $permissions = [self::VIEW];
      }
      elseif ($account->isAuthenticated() && $space->isOpenToAllUsers()) {
        $permissions = [self::VIEW];
      }

      // A floor on top of the roster rank, never in place of it — a manager
      // who also holds the permission keeps publish and manage.
      if ($is_collaboration_server) {
        $permissions = array_values(array_unique([...$permissions, self::VIEW, self::UPDATE]));
      }

      // A disabled space is its managers' alone until they enable it again.
      if (!$space->isPublished() && !$is_manager) {
        $permissions = [];
      }

      if ($permissions) {
        $calculated_permissions->addItem(
          new CalculatedPermissionsItem($permissions, FALSE, self::SCOPE, (int) $id),
        );
      }
    }

    return $calculated_permissions;
  }

  /**
   * {@inheritdoc}
   */
  public function getPersistentCacheContexts(): array {
    // Rosters are per account, not per role.
    return ['user'];
  }

}
