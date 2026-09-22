<?php

declare(strict_types=1);

namespace Drupal\openkb_schema\Hook;

use Drupal\Core\Hook\Attribute\Hook;
use Drupal\node\NodeInterface;
use Drupal\openkb_schema\BodyFormat;

/**
 * Fills in the body's text format.
 */
final class BodyFormatHooks {

  public function __construct(
    private readonly BodyFormat $bodyFormat,
  ) {}

  /**
   * Implements hook_ENTITY_TYPE_presave() for node entities.
   *
   * The format a body is stored under is the field's own configured one, so
   * clients hand in a value and Drupal names the format. A field naming no
   * single format leaves the item as it came in — `BodyFormat::id()` logs it,
   * and the fallback format renders the body.
   *
   * Core leaves a new item's format NULL (`TextItemBase::applyDefaultValue()`,
   * "@todo Add in the filter default format here"). Core issue
   * https://www.drupal.org/i/3556506 makes it respect `allowed_formats` (fixed
   * in 11.x-dev); once that ships, check whether a value-only write still
   * arrives without a format and drop this hook if it does not.
   */
  #[Hook('node_presave')]
  public function fillBodyFormat(NodeInterface $node): void {
    if ($node->bundle() !== BodyFormat::BUNDLE || !$node->hasField(BodyFormat::FIELD)) {
      return;
    }
    foreach ($node->get(BodyFormat::FIELD) as $item) {
      if ($item->format === NULL || $item->format === '') {
        $item->format = $this->bodyFormat->id();
      }
    }
  }

}
