<?php

declare(strict_types=1);

namespace Drupal\inline_comment\Entity;

use Drupal\Core\Entity\ContentEntityTypeInterface;
use Drupal\Core\Entity\Sql\SqlContentEntityStorageSchema;

/**
 * The storage schema of {@see InlineComment}: one row per message, enforced.
 *
 * A statement already skips coordinates it finds stored, but that read and the
 * insert after it are not one act — two callers stating one conversation
 * concurrently both find nothing and both insert. The unique key is what makes
 * a restatement harmless rather than merely unlikely.
 */
final class InlineCommentStorageSchema extends SqlContentEntityStorageSchema {

  /**
   * {@inheritdoc}
   */
  protected function getEntitySchema(ContentEntityTypeInterface $entity_type, $reset = FALSE): array {
    $schema = parent::getEntitySchema($entity_type, $reset);
    $base_table = $this->storage->getBaseTable();

    $schema[$base_table]['unique keys']['inline_comment__coordinates'] = InlineComment::COORDINATES;
    // Every read asks the same way: one entity translation, by anchor.
    $schema[$base_table]['indexes']['inline_comment__commented'] = [
      'entity_type',
      'entity_id',
      'langcode',
      'anchor',
    ];

    return $schema;
  }

}
