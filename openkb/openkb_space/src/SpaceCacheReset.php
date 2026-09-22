<?php

declare(strict_types=1);

namespace Drupal\openkb_space;

use Drupal\Core\DestructableInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;

/**
 * Drops the spaces saved in this request from the entity cache again.
 *
 * Core drops the entry during the save, so a reader that loaded the space
 * just before it can still write its pre-save copy back over it (core
 * #3474843). Dropping it once more when the request ends catches that write.
 */
final class SpaceCacheReset implements DestructableInterface {

  /**
   * Ids of the spaces saved in this request.
   *
   * @var int[]
   */
  private array $ids = [];

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * Records a space that was just saved.
   */
  public function saved(SpaceInterface $space): void {
    $this->ids[(int) $space->id()] = (int) $space->id();
  }

  /**
   * {@inheritdoc}
   */
  public function destruct(): void {
    if ($this->ids) {
      $ids = $this->ids;
      $this->ids = [];
      $this->entityTypeManager->getStorage('openkb_space')->resetCache($ids);
    }
  }

}
