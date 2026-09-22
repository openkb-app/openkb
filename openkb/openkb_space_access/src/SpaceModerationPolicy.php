<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access;

use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\openkb_space\SpaceInterface;

/**
 * Whether moderation applies to an entity, per the space it belongs to.
 *
 * `content_moderation` is installed for `kb_page` unconditionally and the
 * editorial workflow is enforced in the backend regardless. This class answers
 * the *policy* question layered on top of it — does the write surface treat
 * this page's space as moderated — so a space can run wiki-style
 * (save publishes) without the bundle losing its workflow.
 *
 * Two callers consume it, and between them they are the whole feature:
 *   - \Drupal\openkb_collab_api\Controller\CommitResource decides the state a
 *     content write lands in,
 *   - \Drupal\openkb_workflow\Controller\ModerationStatusController reports
 *     `moderated`, which is what makes the editor chrome present or absent.
 *
 * A page in no space is moderated: the flag lives on the space, so with no
 * space there is nothing that could have turned it off, and the bundle's own
 * workflow stands.
 */
final class SpaceModerationPolicy {

  /**
   * The configurable field saying whether edits go through review.
   */
  public const MODERATION_FIELD = 'field_moderation';

  public function __construct(
    private readonly SpaceAccess $spaceAccess,
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * Whether edits in a space go through moderation.
   *
   * An unset value reads as ON: the field's default, and the reading that
   * keeps a space whose flag never got written under review.
   */
  public function isModerated(SpaceInterface $space): bool {
    if (!$space->hasField(self::MODERATION_FIELD)) {
      return TRUE;
    }
    $value = $space->get(self::MODERATION_FIELD)->value;
    return $value === NULL ? TRUE : (bool) $value;
  }

  /**
   * Whether moderation applies to this entity.
   *
   * @param \Drupal\Core\Entity\EntityInterface $entity
   *   The entity being written or reported on.
   *
   * @return bool
   *   TRUE when edits go through review, FALSE when a publish needs none.
   */
  public function applies(EntityInterface $entity): bool {
    $id = $this->spaceAccess->spaceIdOf($entity);
    if ($id === NULL) {
      return TRUE;
    }
    $space = $this->entityTypeManager->getStorage('openkb_space')->load($id);
    // A `field_space` pointing at a space that is gone leaves no policy to
    // read — the strict reading is moderated.
    return $space instanceof SpaceInterface ? $this->isModerated($space) : TRUE;
  }

}
