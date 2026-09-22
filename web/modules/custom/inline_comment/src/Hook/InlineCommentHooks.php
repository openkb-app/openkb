<?php

declare(strict_types=1);

namespace Drupal\inline_comment\Hook;

use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Hook\Attribute\Hook;
use Drupal\inline_comment\InlineCommentManager;

/**
 * The module's hooks.
 */
final class InlineCommentHooks {

  public function __construct(
    private readonly InlineCommentManager $comments,
  ) {}

  /**
   * Implements hook_entity_delete().
   *
   * Messages live beside the commented entity, not on it, so nothing else
   * takes them with it.
   */
  #[Hook('entity_delete')]
  public function entityDelete(EntityInterface $entity): void {
    // Nothing comments on a message, and this fires once per dropped row.
    if ($entity->getEntityTypeId() === 'inline_comment') {
      return;
    }
    $this->comments->deleteFor($entity);
  }

}
