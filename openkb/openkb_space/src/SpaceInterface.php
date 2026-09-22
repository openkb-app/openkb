<?php

declare(strict_types=1);

namespace Drupal\openkb_space;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityChangedInterface;
use Drupal\Core\Entity\EntityPublishedInterface;
use Drupal\Core\Entity\RevisionLogInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\user\EntityOwnerInterface;

/**
 * One openKB space.
 */
interface SpaceInterface extends ContentEntityInterface, EntityOwnerInterface, EntityChangedInterface, EntityPublishedInterface, RevisionLogInterface {

  public const MANAGERS = 'managers';
  public const MEMBERS = 'members';
  public const VIEWERS = 'viewers';

  public const MEMBERS_ONLY = 'members_only';
  public const ALL_USERS = 'all_users';

  /**
   * The URL slug the space is reachable under: its path alias, unslashed.
   */
  public function getSlug(): string;

  /**
   * Whether the account holds a seat on the given roster field.
   */
  public function isOnRoster(string $roster, AccountInterface $account): bool;

  /**
   * Whether every signed-in user may read the space, not only its roster.
   */
  public function isOpenToAllUsers(): bool;

}
