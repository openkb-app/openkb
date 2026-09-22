<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow\Plugin\Validation\Constraint;

use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\node\NodeInterface;
use Drupal\openkb_workflow\BlockAttribution;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\Validator\Constraint;
use Symfony\Component\Validator\ConstraintValidator;

/**
 * Validates the OkbPendingReview constraint.
 */
final class PendingReviewConstraintValidator extends ConstraintValidator implements ContainerInjectionInterface {

  public function __construct(
    private readonly BlockAttribution $blockAttribution,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    return new static($container->get('openkb_workflow.block_attribution'));
  }

  /**
   * {@inheritdoc}
   */
  public function validate(mixed $entity, Constraint $constraint): void {
    if (!$entity instanceof NodeInterface || !$constraint instanceof PendingReviewConstraint) {
      return;
    }
    $blockers = $this->blockAttribution->publicationHold($entity);
    if ($blockers !== []) {
      // At the entity root, deliberately: JSON:API filters violations down to
      // the fields the request named, and a PATCH that publishes implicitly
      // names no moderation_state — a field-pathed violation would be
      // filtered out and the write would sail through.
      $this->context->buildViolation($constraint->message, [
        '@blocks' => implode(', ', array_keys($blockers)),
      ])->addViolation();
    }
    if ($this->blockAttribution->unidentifiedHold($entity)) {
      $this->context->buildViolation($constraint->unidentifiedMessage)->addViolation();
    }
  }

}
