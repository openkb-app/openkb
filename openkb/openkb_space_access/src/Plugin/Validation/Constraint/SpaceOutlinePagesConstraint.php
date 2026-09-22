<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access\Plugin\Validation\Constraint;

use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Validation\Attribute\Constraint;
use Symfony\Component\Validator\Constraint as SymfonyConstraint;

/**
 * An outline only names pages of its own space.
 *
 * The shape of the tree is the space entity's own rule; this adds the one part
 * that has to look at content. Holding it at the field means every writer is
 * bound by it — the drag UI, a JSON:API PATCH, an agent and drush alike.
 */
#[Constraint(
  id: 'OpenkbSpaceOutlinePages',
  label: new TranslatableMarkup('Space outline pages', [], ['context' => 'Validation'])
)]
final class SpaceOutlinePagesConstraint extends SymfonyConstraint {

  /**
   * Violation message for an id that is not a page of this space.
   */
  public string $foreign = 'Page %uuid does not exist in this space.';

}
