<?php

declare(strict_types=1);

namespace Drupal\openkb_space\Plugin\Validation\Constraint;

use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Validation\Attribute\Constraint;
use Symfony\Component\Validator\Constraint as SymfonyConstraint;

/**
 * A name that gives the space a free URL.
 *
 * The name is the space's URL, so every way a name can fail is the name's: one
 * made only of characters the slug drops leaves no address at all, one whose
 * slug is already taken would answer at somebody else's, and one whose slug is
 * a page of the site itself would answer over it.
 */
#[Constraint(
  id: 'OpenkbSpaceName',
  label: new TranslatableMarkup('Space name', [], ['context' => 'Validation'])
)]
final class SpaceNameConstraint extends SymfonyConstraint {

  /**
   * The message for a name that yields no URL.
   */
  public string $message = 'The name %label gives no URL. Use at least one letter or number.';

  /**
   * The message for a name whose URL a page of the site already answers at.
   */
  public string $reservedMessage = 'The name %label is reserved for a system page.';

}
