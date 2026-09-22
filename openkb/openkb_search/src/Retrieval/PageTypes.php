<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Retrieval;

use Drupal\Core\Cache\CacheableMetadata;
use Drupal\openkb_schema\SchemaBuilder;
use Drupal\openkb_schema\SchemaUnavailableException;

/**
 * The document types a search may be narrowed to.
 *
 * The index's `type` attribute carries the frontmatter field's raw value, so
 * what can be filtered for is what `openkb_schema` publishes as that
 * property's `enum`: the frontmatter form display is the one contract that
 * decides both which types exist and whether the field is exposed at all.
 */
final class PageTypes {

  /**
   * The frontmatter property the document type is exposed as.
   */
  private const PROPERTY = 'type';

  public function __construct(
    private readonly SchemaBuilder $schemaBuilder,
  ) {}

  /**
   * The machine names a page's type may hold.
   *
   * @return list<string>
   *   The values, empty where the frontmatter exposes no type.
   */
  public function values(): array {
    try {
      $schema = $this->schemaBuilder->build(new CacheableMetadata());
    }
    catch (SchemaUnavailableException) {
      // Without a frontmatter form display nothing is exposed to filter by.
      return [];
    }
    $properties = $schema['properties'] ?? [];
    $values = is_array($properties) ? ($properties[self::PROPERTY]['enum'] ?? []) : [];
    return is_array($values) ? array_values(array_map('strval', $values)) : [];
  }

  /**
   * Whether a value is one of them; '' narrows nothing and is not one.
   */
  public function has(string $value): bool {
    return $value !== '' && in_array($value, $this->values(), TRUE);
  }

}
