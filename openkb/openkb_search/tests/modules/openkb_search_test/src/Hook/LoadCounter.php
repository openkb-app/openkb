<?php

declare(strict_types=1);

namespace Drupal\openkb_search_test\Hook;

use Drupal\Core\Hook\Attribute\Hook;
use Drupal\Core\State\StateInterface;

/**
 * Counts entity loads, so a read path can be held to loading none.
 *
 * The chunk index carries everything a hit shows, and a page loaded to fill a
 * hit in would be both a query per hit and an access decision taken twice.
 */
final class LoadCounter {

  /**
   * The state key the count is kept under, one per entity type.
   */
  public const STATE_KEY = 'openkb_search_test.entity_loads';

  public function __construct(
    private readonly StateInterface $state,
  ) {}

  /**
   * How many entities of one type have been loaded since the last reset.
   */
  public static function loads(StateInterface $state, string $entityTypeId): int {
    return (int) (($state->get(self::STATE_KEY) ?? [])[$entityTypeId] ?? 0);
  }

  /**
   * Starts counting from zero.
   *
   * Nothing is counted until a test asks for it: the module is installed on
   * every keyless environment, and counting there would write state on every
   * entity load of every request.
   */
  public static function reset(StateInterface $state): void {
    $state->set(self::STATE_KEY, []);
  }

  /**
   * Implements hook_entity_load().
   */
  #[Hook('entity_load')]
  public function entityLoad(array $entities, string $entity_type_id): void {
    $counts = $this->state->get(self::STATE_KEY);
    if ($counts === NULL) {
      return;
    }
    $counts[$entity_type_id] = ($counts[$entity_type_id] ?? 0) + count($entities);
    $this->state->set(self::STATE_KEY, $counts);
  }

}
