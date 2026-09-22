<?php

declare(strict_types=1);

namespace Drupal\openkb_space\Plugin\Validation\Constraint;

use Drupal\Core\Field\FieldItemListInterface;
use Symfony\Component\Validator\Constraint;
use Symfony\Component\Validator\ConstraintValidator;

/**
 * Validates {@see SpaceOutlineConstraint}.
 */
final class SpaceOutlineConstraintValidator extends ConstraintValidator {

  /**
   * {@inheritdoc}
   */
  public function validate(mixed $value, Constraint $constraint): void {
    assert($constraint instanceof SpaceOutlineConstraint);
    if (!$value instanceof FieldItemListInterface) {
      return;
    }
    $json = trim((string) ($value->first()?->value ?? ''));
    if ($json === '') {
      return;
    }
    $tree = json_decode($json, TRUE);
    if (!is_array($tree) || !array_is_list($tree)) {
      $this->context->addViolation($constraint->malformed);
      return;
    }
    $ids = [];
    if (!$this->collect($tree, $ids, $constraint)) {
      return;
    }
    foreach (array_count_values($ids) as $id => $count) {
      if ($count > 1) {
        $this->context->addViolation($constraint->duplicate, ['%id' => $id]);
      }
    }
  }

  /**
   * Walks the tree depth-first; FALSE after the first shape violation.
   */
  private function collect(array $nodes, array &$ids, SpaceOutlineConstraint $constraint): bool {
    foreach ($nodes as $node) {
      $children = $node['children'] ?? [];
      if (!is_array($node) || !is_string($node['id'] ?? NULL) || $node['id'] === '' || !is_array($children) || !array_is_list($children)) {
        $this->context->addViolation($constraint->shape);
        return FALSE;
      }
      $ids[] = $node['id'];
      if (!$this->collect($children, $ids, $constraint)) {
        return FALSE;
      }
    }
    return TRUE;
  }

}
