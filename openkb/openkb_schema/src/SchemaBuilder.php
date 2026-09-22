<?php

declare(strict_types=1);

namespace Drupal\openkb_schema;

use Drupal\Core\Cache\RefinableCacheableDependencyInterface;
use Drupal\Core\Entity\Display\EntityFormDisplayInterface;
use Drupal\Core\Entity\EntityFieldManagerInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Field\FieldDefinitionInterface;
use Drupal\Core\Field\FieldStorageDefinitionInterface;
use Drupal\field\FieldConfigInterface;
use Drupal\filter\FilterFormatInterface;

/**
 * Derives the frontmatter JSON Schema from the `frontmatter` form display.
 *
 * The form display `node.kb_page.frontmatter` is the single exposure
 * contract: every configurable field placed in it becomes a schema property,
 * property order follows component weight, and the widget configuration is
 * shipped as a rendering hint (`x-widget`). Site-builders manage exposure
 * with Field UI — no code change, no hand-maintained mapping file.
 *
 * Frontmatter keys are field machine names minus the `field_` prefix
 * (`field_owner` → `owner`).
 *
 * The response also carries `body.allowedHtml`: the tags, attributes and
 * attribute values the body field's configured text format allows, which is
 * what the frontend's comark tree passes filter against.
 */
class SchemaBuilder {

  /**
   * Form mode acting as the exposure contract.
   */
  public const FORM_MODE = 'frontmatter';

  /**
   * Constructs the schema builder.
   */
  public function __construct(
    protected readonly EntityTypeManagerInterface $entityTypeManager,
    protected readonly EntityFieldManagerInterface $entityFieldManager,
    protected readonly BodyFormat $bodyFormat,
  ) {}

  /**
   * Builds the frontmatter JSON Schema.
   *
   * @param \Drupal\Core\Cache\RefinableCacheableDependencyInterface $cacheability
   *   Collects the config dependencies (form display + field configs) so
   *   responses invalidate when the exposure contract changes.
   *
   * @return array
   *   JSON Schema (draft 2020-12) as an array; `properties` is a \stdClass
   *   when empty so it serialises as a JSON object.
   *
   * @throws \Drupal\openkb_schema\SchemaUnavailableException
   *   When the frontmatter form display does not exist.
   */
  public function build(RefinableCacheableDependencyInterface $cacheability): array {
    $display = $this->formDisplay();
    $cacheability->addCacheableDependency($display);

    $components = $this->exposedComponents($display);
    $definitions = $this->entityFieldManager->getFieldDefinitions(BodyFormat::ENTITY_TYPE_ID, BodyFormat::BUNDLE);

    $properties = [];
    $required = [];
    foreach ($components as $field_name => $component) {
      $definition = $definitions[$field_name];
      $cacheability->addCacheableDependency($definition);
      $key = str_starts_with($field_name, 'field_') ? substr($field_name, strlen('field_')) : $field_name;
      $properties[$key] = $this->buildProperty($definition, $component);
      if ($definition->isRequired()) {
        $required[] = $key;
      }
    }

    $schema = [
      '$schema' => 'https://json-schema.org/draft/2020-12/schema',
      'title' => BodyFormat::BUNDLE . ' frontmatter',
      'description' => sprintf('Frontmatter contract derived from the `%s` form display on %s.%s.', self::FORM_MODE, BodyFormat::ENTITY_TYPE_ID, BodyFormat::BUNDLE),
      'type' => 'object',
      'properties' => $properties ?: new \stdClass(),
      'additionalProperties' => FALSE,
    ];
    if ($required) {
      $schema['required'] = $required;
    }
    if (($allowed_html = $this->allowedHtml($cacheability)) !== NULL) {
      $schema['body'] = ['allowedHtml' => $allowed_html];
    }
    return $schema;
  }

  /**
   * The tags and attributes the body field's text format allows.
   *
   * Drupal's own parsed restrictions, as `{tag: true | {attribute: true |
   * {value: true}}}` — `true` for a whole tag allowing any attribute, `true`
   * for one attribute any value, a value map only the listed ones. A trailing
   * `*` globs, on an attribute name and on a value alike, and the `*` tag
   * carries what applies to every tag. Attributes the format forbids outright
   * are dropped rather than published as `false`, which is what core does
   * before it applies the same list.
   *
   * @param \Drupal\Core\Cache\RefinableCacheableDependencyInterface $cacheability
   *   Collects the field and format config, so editing either invalidates
   *   responses.
   *
   * @return array<string, \stdClass|true>|null
   *   The map, or NULL when there is no single format, or it restricts
   *   nothing.
   */
  protected function allowedHtml(RefinableCacheableDependencyInterface $cacheability): ?array {
    // Tagged whether or not the config exists, so creating it invalidates too.
    $cacheability->addCacheTags([BodyFormat::CACHE_TAG]);
    $format_id = $this->bodyFormat->id();
    if ($format_id === NULL) {
      return NULL;
    }
    $cacheability->addCacheTags(['config:filter.format.' . $format_id]);
    $format = $this->entityTypeManager->getStorage('filter_format')->load($format_id);
    if (!$format instanceof FilterFormatInterface) {
      return NULL;
    }
    $restrictions = $format->getHtmlRestrictions();
    if (!is_array($restrictions)) {
      return NULL;
    }
    $allowed = [];
    foreach ($restrictions['allowed'] ?? [] as $tag => $attributes) {
      // TRUE is "any attribute", FALSE "none at all". Cast a list so a tag
      // carrying no attribute still publishes as an object.
      $allowed[$tag] = $attributes === TRUE
        ? TRUE
        : (object) array_filter(is_array($attributes) ? $attributes : []);
    }
    return $allowed;
  }

  /**
   * The exposed field machine names, in display order.
   *
   * @param \Drupal\Core\Cache\RefinableCacheableDependencyInterface|null $cacheability
   *   Collects the form display and field configs the answer depends on.
   *
   * @return string[]
   *   Machine names of the configurable fields the contract exposes.
   *
   * @throws \Drupal\openkb_schema\SchemaUnavailableException
   *   When the frontmatter form display does not exist.
   */
  public function exposedFieldNames(?RefinableCacheableDependencyInterface $cacheability = NULL): array {
    $display = $this->formDisplay();
    $cacheability?->addCacheableDependency($display);
    $definitions = $this->entityFieldManager->getFieldDefinitions(BodyFormat::ENTITY_TYPE_ID, BodyFormat::BUNDLE);
    $names = array_keys($this->exposedComponents($display));
    foreach ($names as $name) {
      $cacheability?->addCacheableDependency($definitions[$name]);
    }
    return $names;
  }

  /**
   * Loads the form display acting as the exposure contract.
   *
   * @return \Drupal\Core\Entity\Display\EntityFormDisplayInterface
   *   The frontmatter form display.
   *
   * @throws \Drupal\openkb_schema\SchemaUnavailableException
   *   When it does not exist.
   */
  protected function formDisplay(): EntityFormDisplayInterface {
    $display_id = BodyFormat::ENTITY_TYPE_ID . '.' . BodyFormat::BUNDLE . '.' . self::FORM_MODE;
    $display = $this->entityTypeManager->getStorage('entity_form_display')->load($display_id);
    if (!$display instanceof EntityFormDisplayInterface) {
      throw new SchemaUnavailableException(sprintf('Form display %s does not exist.', $display_id));
    }
    return $display;
  }

  /**
   * The display's configurable-field components, ordered by weight.
   *
   * Extra-field components — actions, contextual pseudo-fields — carry no data
   * contract and no field access, so they are not exposure.
   *
   * @param \Drupal\Core\Entity\Display\EntityFormDisplayInterface $display
   *   The form display acting as the exposure contract.
   *
   * @return array<string, array>
   *   Components keyed by field machine name.
   */
  protected function exposedComponents(EntityFormDisplayInterface $display): array {
    $definitions = $this->entityFieldManager->getFieldDefinitions(BodyFormat::ENTITY_TYPE_ID, BodyFormat::BUNDLE);
    $components = array_filter(
      $display->getComponents(),
      static fn (string $name): bool => ($definitions[$name] ?? NULL) instanceof FieldConfigInterface,
      ARRAY_FILTER_USE_KEY,
    );
    uasort($components, static fn (array $a, array $b): int => ($a['weight'] ?? 0) <=> ($b['weight'] ?? 0));
    return $components;
  }

  /**
   * Builds the schema property for one exposed field.
   *
   * @param \Drupal\Core\Field\FieldDefinitionInterface $definition
   *   The field definition.
   * @param array $component
   *   The form-display component (widget type, settings, weight).
   *
   * @return array
   *   The JSON Schema property.
   */
  protected function buildProperty(FieldDefinitionInterface $definition, array $component): array {
    $storage = $definition->getFieldStorageDefinition();
    $item = $this->buildItemSchema($definition, $storage);

    $cardinality = $storage->getCardinality();
    if ($cardinality === 1) {
      $property = $item;
    }
    else {
      $property = [
        'type' => 'array',
        'items' => $item,
      ];
      if ($cardinality !== FieldStorageDefinitionInterface::CARDINALITY_UNLIMITED) {
        $property['maxItems'] = $cardinality;
      }
    }

    $property['title'] = (string) $definition->getLabel();
    if (($description = (string) $definition->getDescription()) !== '') {
      $property['description'] = $description;
    }
    if (($default = $this->defaultValue($definition, $cardinality)) !== NULL) {
      $property['default'] = $default;
    }
    $property['x-widget'] = [
      'type' => $component['type'] ?? '',
      'settings' => ($component['settings'] ?? []) ?: new \stdClass(),
    ];
    // The frontmatter key drops the `field_` prefix, so it cannot address the
    // field in JSON:API. Consumers that read or write entity data — the collab
    // session's field seeding, the commit payload — need the machine name.
    $property['x-field-name'] = $definition->getName();
    return $property;
  }

  /**
   * Builds the schema for a single field item (cardinality-independent).
   *
   * @param \Drupal\Core\Field\FieldDefinitionInterface $definition
   *   The field definition.
   * @param \Drupal\Core\Field\FieldStorageDefinitionInterface $storage
   *   The field storage definition.
   *
   * @return array
   *   The JSON Schema for one value.
   */
  protected function buildItemSchema(FieldDefinitionInterface $definition, FieldStorageDefinitionInterface $storage): array {
    switch ($storage->getType()) {
      case 'list_string':
        // Runtime shape of allowed_values is a value => label map.
        $allowed = $storage->getSetting('allowed_values') ?? [];
        return [
          'type' => 'string',
          'enum' => array_map('strval', array_keys($allowed)),
          'x-enum-labels' => array_map('strval', $allowed) ?: new \stdClass(),
        ];

      case 'entity_reference':
        $handler_settings = $definition->getSetting('handler_settings') ?? [];
        $target_bundles = array_values(array_map('strval', $handler_settings['target_bundles'] ?? []));
        $reference = ['entity_type' => (string) $storage->getSetting('target_type')];
        if ($target_bundles) {
          $reference['bundles'] = $target_bundles;
        }
        return [
          'type' => 'object',
          'properties' => [
            'id' => [
              'type' => 'string',
              'description' => 'UUID of the referenced entity.',
            ],
            'label' => [
              'type' => 'string',
              'description' => 'Display label of the referenced entity.',
            ],
          ],
          'required' => ['id'],
          'additionalProperties' => FALSE,
          'x-entity-reference' => $reference,
        ];

      case 'boolean':
        return ['type' => 'boolean'];

      case 'integer':
        return ['type' => 'integer'];

      case 'decimal':
      case 'float':
        return ['type' => 'number'];

      default:
        // string, string_long, and any not-yet-mapped type: plain string.
        return ['type' => 'string'];
    }
  }

  /**
   * Extracts a scalar default value for string-ish fields.
   *
   * @param \Drupal\Core\Field\FieldDefinitionInterface $definition
   *   The field definition.
   * @param int $cardinality
   *   The storage cardinality.
   *
   * @return string|null
   *   The default value, or NULL when there is none (or it is not scalar).
   */
  protected function defaultValue(FieldDefinitionInterface $definition, int $cardinality): ?string {
    if ($cardinality !== 1) {
      return NULL;
    }
    $default = $definition->getDefaultValueLiteral();
    $value = $default[0]['value'] ?? NULL;
    return is_scalar($value) ? (string) $value : NULL;
  }

}
