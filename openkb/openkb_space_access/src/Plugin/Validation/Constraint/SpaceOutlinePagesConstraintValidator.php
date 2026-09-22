<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access\Plugin\Validation\Constraint;

use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Field\FieldItemListInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\Validator\Constraint;
use Symfony\Component\Validator\ConstraintValidator;

/**
 * Validates {@see SpaceOutlinePagesConstraint}.
 */
final class SpaceOutlinePagesConstraintValidator extends ConstraintValidator implements ContainerInjectionInterface {

  /**
   * The bundle an outline entry may name.
   */
  private const BUNDLE = 'kb_page';

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self($container->get('entity_type.manager'));
  }

  /**
   * {@inheritdoc}
   */
  public function validate(mixed $value, Constraint $constraint): void {
    assert($constraint instanceof SpaceOutlinePagesConstraint);
    if (!$value instanceof FieldItemListInterface || $value->isEmpty()) {
      return;
    }
    $tree = json_decode((string) ($value->first()?->value ?? ''), TRUE);
    if (!is_array($tree)) {
      return;
    }
    $uuids = [];
    self::collect($tree, $uuids);
    if ($uuids === []) {
      return;
    }

    foreach (array_diff(array_unique($uuids), $this->pagesOfSpace($value, $uuids)) as $uuid) {
      $this->context->addViolation($constraint->foreign, ['%uuid' => $uuid]);
    }
  }

  /**
   * Collects every id in the tree. A malformed node is the shape rule's.
   *
   * @param array $nodes
   *   The sibling list to walk.
   * @param string[] $uuids
   *   Collects the ids encountered.
   */
  private static function collect(array $nodes, array &$uuids): void {
    foreach ($nodes as $node) {
      if (!is_array($node) || !is_string($node['id'] ?? NULL)) {
        continue;
      }
      $uuids[] = $node['id'];
      $children = $node['children'] ?? [];
      if (is_array($children)) {
        self::collect($children, $uuids);
      }
    }
  }

  /**
   * The subset of the given UUIDs that are pages assigned to this space.
   *
   * Deliberately unfiltered by access: what belongs in the tree is a property
   * of the content, not of who is looking. Read-side rendering is where the
   * session's grants apply.
   *
   * @param \Drupal\Core\Field\FieldItemListInterface $items
   *   The outline field, whose entity is the space.
   * @param string[] $uuids
   *   The referenced page UUIDs.
   *
   * @return string[]
   *   The UUIDs that resolve to a page of this space.
   */
  private function pagesOfSpace(FieldItemListInterface $items, array $uuids): array {
    $id = $items->getEntity()->id();
    // A space that has not been saved yet owns no pages, so every reference
    // is foreign by definition.
    if ($id === NULL) {
      return [];
    }
    $storage = $this->entityTypeManager->getStorage('node');
    $nids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('type', self::BUNDLE)
      ->condition('uuid', array_values(array_unique($uuids)), 'IN')
      ->condition('field_space', $id)
      ->execute();
    return array_map(
      static fn ($node) => $node->uuid(),
      $storage->loadMultiple($nids),
    );
  }

}
