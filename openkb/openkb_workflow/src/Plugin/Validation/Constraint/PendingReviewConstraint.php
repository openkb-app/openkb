<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow\Plugin\Validation\Constraint;

use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Validation\Attribute\Constraint;
use Symfony\Component\Validator\Constraint as SymfonyConstraint;

/**
 * Refuses a write that would publish blocks still awaiting review.
 *
 * The wire-side half of the one gate (ADR 0004): JSON:API validates every
 * write, so this closes the raw-PATCH path to the live page. The commit
 * routes divert a blocked content write to a draft before validation runs,
 * so they pass here; programmatic saves (seeds, migrations) do not validate
 * and are deliberately untouched.
 */
#[Constraint(
  id: 'OkbPendingReview',
  label: new TranslatableMarkup('Publication blocked by pending reviews', [], ['context' => 'Validation']),
  type: 'entity',
)]
final class PendingReviewConstraint extends SymfonyConstraint {

  /**
   * The violation message. Machine-detectable via the constraint id.
   */
  public string $message = 'Publishing is blocked: @blocks still await review.';

  /**
   * The refusal of text outside identified blocks — a raw write's remainder.
   *
   * Not a review question: an id-less block cannot be flagged or approved, so
   * there is nothing a reviewer could clear (the editor ids every block it
   * produces, containers via the `::block{#id}` wrapper fence).
   */
  public string $unidentifiedMessage = 'Publishing is blocked: the body must consist of identified blocks.';

}
