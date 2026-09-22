<?php

declare(strict_types=1);

namespace Drupal\openkb_space\Plugin\Validation\Constraint;

use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Validation\Attribute\Constraint;
use Symfony\Component\Validator\Constraint as SymfonyConstraint;

/**
 * The shape of a space's outline: a nested ordered list of page ids.
 *
 * @code
 * [{"id": "<uuid>", "children": [{"id": "<uuid>"}]}]
 * @endcode
 */
#[Constraint(
  id: 'OpenkbSpaceOutline',
  label: new TranslatableMarkup('Space outline', [], ['context' => 'Validation'])
)]
final class SpaceOutlineConstraint extends SymfonyConstraint {

  /**
   * Violation: the value is not a JSON list.
   */
  public string $malformed = 'The outline is not a JSON list.';

  /**
   * Violation: an entry has no string id, or its children are not a list.
   */
  public string $shape = 'Every outline entry must be an object with a non-empty string "id"; "children", when present, must be a list.';

  /**
   * Violation: a page is placed twice.
   */
  public string $duplicate = 'Page %id appears more than once in the outline.';

}
