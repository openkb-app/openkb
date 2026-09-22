<?php

declare(strict_types=1);

namespace Drupal\openkb_space;

use Drupal\Core\Entity\ContentEntityStorageInterface;

/**
 * Storage for spaces, with the two reads every consumer needs.
 */
interface SpaceStorageInterface extends ContentEntityStorageInterface {

  /**
   * Every space, keyed by id, access checks off.
   *
   * This is the input to an access decision, not a decision itself: the access
   * policy has to walk every space to calculate per-space permissions.
   *
   * @return \Drupal\openkb_space\SpaceInterface[]
   *   The spaces.
   */
  public function all(): array;

  /**
   * The space a URL slug names, or NULL when no space carries it.
   */
  public function getBySlug(string $slug): ?SpaceInterface;

}
