<?php

declare(strict_types=1);

namespace Drupal\openkb_collab_api_field_test\Hook;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Field\FieldDefinitionInterface;
use Drupal\Core\Field\FieldItemListInterface;
use Drupal\Core\Hook\Attribute\Hook;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\State\StateInterface;

/**
 * Denies edit access to the field named in state, for every account.
 */
final class FieldAccessHooks {

  /**
   * State key holding the field machine name to deny.
   */
  public const DENIED_FIELD = 'openkb_collab_api_field_test.denied_field';

  /**
   * Constructs the hook implementation.
   */
  public function __construct(
    private readonly StateInterface $state,
  ) {}

  /**
   * Implements hook_entity_field_access().
   */
  #[Hook('entity_field_access')]
  public function entityFieldAccess(
    string $operation,
    FieldDefinitionInterface $field_definition,
    AccountInterface $account,
    ?FieldItemListInterface $items = NULL,
  ): AccessResultInterface {
    $denied = $this->state->get(self::DENIED_FIELD);
    if ($operation !== 'edit' || $field_definition->getName() !== $denied) {
      return AccessResult::neutral();
    }
    return AccessResult::forbidden('Denied by openkb_collab_api_field_test.');
  }

}
