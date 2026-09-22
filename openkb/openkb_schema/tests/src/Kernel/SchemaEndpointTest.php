<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_schema\Kernel;

use Drupal\Core\Cache\CacheableResponseInterface;
use Drupal\Core\Entity\Entity\EntityFormDisplay;
use Drupal\Core\Entity\Entity\EntityFormMode;
use Drupal\field\Entity\FieldConfig;
use Drupal\field\Entity\FieldStorageConfig;
use Drupal\filter\Entity\FilterFormat;
use Drupal\KernelTests\KernelTestBase;
use Drupal\node\Entity\NodeType;
use Drupal\taxonomy\Entity\Vocabulary;
use Drupal\user\Entity\Role;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Yaml\Yaml;

/**
 * Tests the derived frontmatter JSON Schema endpoint.
 *
 * Recreates the kb_page field model + `frontmatter` form display
 * programmatically (the recipe is not applied in kernel tests) and exercises
 * GET /openkb/schema through the real http_kernel.
 *
 * @group openkb_schema
 */
final class SchemaEndpointTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'filter',
    'text',
    'node',
    'options',
    'taxonomy',
    'openkb_schema',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();

    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('taxonomy_term');
    $this->installConfig(['user']);

    // The endpoint shares the anonymous-read posture of the CE-API.
    Role::load(Role::ANONYMOUS_ID)->grantPermission('access content')->save();

    NodeType::create(['type' => 'kb_page', 'name' => 'Page'])->save();
    Vocabulary::create(['vid' => 'kb_tags', 'name' => 'KB tags'])->save();

    $this->createField('field_type', 'list_string', 1, [
      'storage_settings' => [
        'allowed_values' => [
          'article' => 'Article',
          'adr' => 'ADR',
          'guide' => 'Guide',
          'runbook' => 'Runbook',
        ],
      ],
      'field' => [
        'label' => 'Type',
        'required' => TRUE,
        'default_value' => [['value' => 'article']],
      ],
    ]);
    $this->createField('field_summary', 'string_long', 1, [
      'field' => ['label' => 'Summary'],
    ]);
    $this->createField('field_owner', 'entity_reference', 1, [
      'storage_settings' => ['target_type' => 'user'],
      'field' => [
        'label' => 'Owner',
        'settings' => ['handler' => 'default:user'],
      ],
    ]);
    $this->createField('field_contributors', 'entity_reference', -1, [
      'storage_settings' => ['target_type' => 'user'],
      'field' => [
        'label' => 'Contributors',
        'settings' => ['handler' => 'default:user'],
      ],
    ]);
    $this->createField('field_tags', 'entity_reference', -1, [
      'storage_settings' => ['target_type' => 'taxonomy_term'],
      'field' => [
        'label' => 'Tags',
        'settings' => [
          'handler' => 'default:taxonomy_term',
          'handler_settings' => ['target_bundles' => ['kb_tags' => 'kb_tags']],
        ],
      ],
    ]);
    // A field that exists on the bundle but is NOT placed in the
    // frontmatter form display — must never surface in the schema.
    $this->createField('field_unplaced', 'string', 1, [
      'field' => ['label' => 'Unplaced'],
    ]);
    // The body is not frontmatter either; the format it is configured with is
    // what the allowed list comes from.
    $this->createField('field_kb_body', 'text_long', 1, [
      'field' => [
        'label' => 'Body',
        'settings' => ['allowed_formats' => ['comark']],
      ],
    ]);

    EntityFormMode::create([
      'id' => 'node.frontmatter',
      'label' => 'Frontmatter',
      'targetEntityType' => 'node',
    ])->save();

    EntityFormDisplay::create([
      'targetEntityType' => 'node',
      'bundle' => 'kb_page',
      'mode' => 'frontmatter',
      'status' => TRUE,
    ])
      ->setComponent('field_type', ['type' => 'options_select', 'weight' => 0])
      ->setComponent('field_summary', [
        'type' => 'string_textarea',
        'weight' => 1,
        'settings' => ['rows' => 3, 'placeholder' => ''],
      ])
      ->setComponent('field_owner', ['type' => 'entity_reference_autocomplete', 'weight' => 2])
      ->setComponent('field_contributors', ['type' => 'entity_reference_autocomplete', 'weight' => 3])
      ->setComponent('field_tags', ['type' => 'entity_reference_autocomplete_tags', 'weight' => 4])
      ->save();
  }

  /**
   * The schema exposes exactly the placed fields, in display order.
   */
  public function testSchemaShape(): void {
    $response = $this->request();
    $this->assertSame(200, $response->getStatusCode());
    $this->assertStringStartsWith('application/json', (string) $response->headers->get('Content-Type'));

    $schema = $this->decode($response);
    $this->assertSame('https://json-schema.org/draft/2020-12/schema', $schema['$schema']);
    $this->assertSame('object', $schema['type']);
    $this->assertFalse($schema['additionalProperties']);

    // Frontmatter keys = machine name minus `field_`, ordered by weight.
    $this->assertSame(
      ['type', 'summary', 'owner', 'contributors', 'tags'],
      array_keys($schema['properties']),
    );
    $this->assertSame(['type'], $schema['required']);

    $summary = $schema['properties']['summary'];
    $this->assertSame('string', $summary['type']);
    $this->assertSame('Summary', $summary['title']);
    $this->assertSame('string_textarea', $summary['x-widget']['type']);
    $this->assertSame(3, $summary['x-widget']['settings']['rows']);
    $this->assertSame('field_summary', $summary['x-field-name']);

    $owner = $schema['properties']['owner'];
    $this->assertSame('object', $owner['type']);
    $this->assertSame(['id'], $owner['required']);
    $this->assertSame('string', $owner['properties']['id']['type']);
    $this->assertSame('string', $owner['properties']['label']['type']);
    $this->assertSame(['entity_type' => 'user'], $owner['x-entity-reference']);

    $contributors = $schema['properties']['contributors'];
    $this->assertSame('array', $contributors['type']);
    $this->assertArrayNotHasKey('maxItems', $contributors);
    $this->assertSame('object', $contributors['items']['type']);
    $this->assertSame(['entity_type' => 'user'], $contributors['items']['x-entity-reference']);

    $tags = $schema['properties']['tags'];
    $this->assertSame('array', $tags['type']);
    $this->assertSame(
      ['entity_type' => 'taxonomy_term', 'bundles' => ['kb_tags']],
      $tags['items']['x-entity-reference'],
    );
  }

  /**
   * List fields carry their allowed values as enum + labels.
   */
  public function testEnumValues(): void {
    $schema = $this->decode($this->request());
    $type = $schema['properties']['type'];
    $this->assertSame('string', $type['type']);
    $this->assertSame(['article', 'adr', 'guide', 'runbook'], $type['enum']);
    $this->assertSame(
      ['article' => 'Article', 'adr' => 'ADR', 'guide' => 'Guide', 'runbook' => 'Runbook'],
      $type['x-enum-labels'],
    );
    $this->assertSame('article', $type['default']);
  }

  /**
   * Only placement in the form display decides exposure — zero code changes.
   */
  public function testPlacedUnplacedConsistency(): void {
    $schema = $this->decode($this->request());
    $this->assertArrayNotHasKey('unplaced', $schema['properties']);
    $this->assertArrayHasKey('tags', $schema['properties']);

    // Removing a placed field from the form mode removes it from the schema.
    $display = EntityFormDisplay::load('node.kb_page.frontmatter');
    $display->removeComponent('field_tags')->save();
    $schema = $this->decode($this->request());
    $this->assertArrayNotHasKey('tags', $schema['properties']);

    // Placing a previously unplaced field adds it.
    $display->setComponent('field_unplaced', ['type' => 'string_textfield', 'weight' => 10])->save();
    $schema = $this->decode($this->request());
    $this->assertArrayHasKey('unplaced', $schema['properties']);
    $this->assertSame(
      ['type', 'summary', 'owner', 'contributors', 'unplaced'],
      array_keys($schema['properties']),
    );
  }

  /**
   * The response carries the config cache tags of the exposure contract.
   */
  public function testCacheTags(): void {
    $response = $this->request();
    $this->assertInstanceOf(CacheableResponseInterface::class, $response);
    $tags = $response->getCacheableMetadata()->getCacheTags();
    $this->assertContains('config:core.entity_form_display.node.kb_page.frontmatter', $tags);
    foreach (['field_type', 'field_summary', 'field_owner', 'field_contributors', 'field_tags'] as $field_name) {
      $this->assertContains("config:field.field.node.kb_page.$field_name", $tags);
    }
    $this->assertNotContains('config:field.field.node.kb_page.field_unplaced', $tags);
  }

  /**
   * The body's allowed list mirrors the shipped text format.
   */
  public function testBodyAllowedHtml(): void {
    $this->importComarkFormat();
    $allowed = $this->decode($this->request())['body']['allowedHtml'];

    // A tag listed without attributes carries an empty map, not a null.
    $this->assertSame([], $allowed['em']);
    // A bare attribute takes any value.
    $this->assertSame(['href' => TRUE, 'hreflang' => TRUE, 'title' => TRUE], $allowed['a']);
    // Components are listed the same way HTML tags are.
    $this->assertSame(['type' => TRUE, 'id' => ['b-*' => TRUE]], $allowed['callout']);
    $this->assertSame(['media' => TRUE, 'alt' => TRUE, 'id' => ['b-*' => TRUE]], $allowed['image']);
    // A quoted attribute lists the values it accepts, a trailing `*` globbing.
    $this->assertSame(['class' => ['language-*' => TRUE]], $allowed['code']);
    $this->assertSame([
      'style' => [
        'text-align:left' => TRUE,
        'text-align:center' => TRUE,
        'text-align:right' => TRUE,
      ],
    ], $allowed['th']);
    // `*` carries what every tag may have. Core forbids style and on* there
    // whatever the setting says, and a forbidden attribute is not published.
    $this->assertSame(['lang' => TRUE, 'dir' => ['ltr' => TRUE, 'rtl' => TRUE]], $allowed['*']);
    // Nothing may carry a free-form style or class.
    foreach ($allowed as $tag => $attributes) {
      foreach (['style', 'class'] as $name) {
        $this->assertNotSame(TRUE, $attributes[$name] ?? NULL, "$tag allows any $name");
      }
    }

    // Editing the format is what changes the list.
    FilterFormat::load('comark')
      ->setFilterConfig('filter_html', ['settings' => ['allowed_html' => '<p> <em class="lead">']])
      ->save();
    $this->assertSame(
      [
        'p' => [],
        'em' => ['class' => ['lead' => TRUE]],
        '*' => ['lang' => TRUE, 'dir' => ['ltr' => TRUE, 'rtl' => TRUE]],
      ],
      $this->decode($this->request())['body']['allowedHtml'],
    );
  }

  /**
   * A tag the format allows every attribute on publishes as `true`.
   *
   * Core says so with a bare TRUE, which a second restricting filter can put
   * on a tag; the frontend reads it as "hold this tag to the built-in checks
   * only". A tag allowing none stays an empty map.
   */
  public function testBodyAllowedHtmlAnyAttribute(): void {
    $this->enableModules(['filter_test']);
    FilterFormat::create([
      'format' => 'comark',
      'name' => 'Comark',
      'filters' => [
        'filter_test_restrict_tags_and_attributes' => [
          'status' => TRUE,
          'settings' => ['restrictions' => ['allowed' => ['p' => TRUE, 'em' => FALSE]]],
        ],
      ],
    ])->save();

    $allowed = $this->decode($this->request())['body']['allowedHtml'];
    $this->assertTrue($allowed['p']);
    $this->assertSame([], $allowed['em']);
  }

  /**
   * A format restricting nothing publishes no list; the frontend floor holds.
   */
  public function testBodyWithoutRestrictions(): void {
    FilterFormat::create(['format' => 'comark', 'name' => 'Comark', 'filters' => []])->save();
    $this->assertArrayNotHasKey('body', $this->decode($this->request()));
  }

  /**
   * A format the field names but the site does not have publishes no list.
   */
  public function testBodyFormatMissing(): void {
    $this->assertArrayNotHasKey('body', $this->decode($this->request()));
  }

  /**
   * The response is tagged on the format, so editing the list invalidates it.
   */
  public function testBodyFormatCacheTag(): void {
    $response = $this->request();
    $this->assertInstanceOf(CacheableResponseInterface::class, $response);
    $tags = $response->getCacheableMetadata()->getCacheTags();
    $this->assertContains('config:filter.format.comark', $tags);
    // The field names the format, so retargeting it invalidates too.
    $this->assertContains('config:field.field.node.kb_page.field_kb_body', $tags);
  }

  /**
   * The list is the one the body field's configured format carries.
   */
  public function testBodyFormatFollowsTheField(): void {
    $this->importComarkFormat();
    FilterFormat::create([
      'format' => 'plain',
      'name' => 'Plain',
      'filters' => [
        'filter_html' => [
          'status' => TRUE,
          'settings' => ['allowed_html' => '<em>'],
        ],
      ],
    ])->save();
    $this->assertArrayHasKey('callout', $this->decode($this->request())['body']['allowedHtml']);

    $this->setBodyFormats(['plain']);
    $this->assertSame(
      [
        'em' => [],
        '*' => ['lang' => TRUE, 'dir' => ['ltr' => TRUE, 'rtl' => TRUE]],
      ],
      $this->decode($this->request())['body']['allowedHtml'],
    );
  }

  /**
   * Anything but one configured format publishes no list; the floor holds.
   */
  public function testBodyFormatMustBeUnambiguous(): void {
    $this->importComarkFormat();
    $this->setBodyFormats(['comark', 'plain_text']);
    $this->assertArrayNotHasKey('body', $this->decode($this->request()));

    $this->setBodyFormats([]);
    $this->assertArrayNotHasKey('body', $this->decode($this->request()));
  }

  /**
   * Creates the comark format from the shipped recipe config.
   */
  private function importComarkFormat(): void {
    $file = dirname(DRUPAL_ROOT) . '/recipes/openkb_recipe_main/config/filter.format.comark.yml';
    FilterFormat::create(Yaml::parseFile($file))->save();
  }

  /**
   * Sets the text formats the body field is configured with.
   */
  private function setBodyFormats(array $formats): void {
    FieldConfig::loadByName('node', 'kb_page', 'field_kb_body')
      ->setSetting('allowed_formats', $formats)
      ->save();
  }

  /**
   * Issues a real GET /openkb/schema through the http_kernel.
   */
  private function request(): Response {
    /** @var \Symfony\Component\HttpKernel\HttpKernelInterface $http_kernel */
    $http_kernel = $this->container->get('http_kernel');
    return $http_kernel->handle(Request::create('/openkb/schema'));
  }

  /**
   * Decodes a JSON response body.
   */
  private function decode(Response $response): array {
    return json_decode((string) $response->getContent(), TRUE, 512, JSON_THROW_ON_ERROR);
  }

  /**
   * Creates a field storage + field config pair on node.kb_page.
   *
   * @param string $field_name
   *   The field machine name.
   * @param string $type
   *   The field type plugin id.
   * @param int $cardinality
   *   The storage cardinality.
   * @param array $options
   *   Optional 'storage_settings' and 'field' (FieldConfig values) overrides.
   */
  private function createField(string $field_name, string $type, int $cardinality, array $options = []): void {
    FieldStorageConfig::create([
      'field_name' => $field_name,
      'entity_type' => 'node',
      'type' => $type,
      'cardinality' => $cardinality,
      'settings' => $options['storage_settings'] ?? [],
    ])->save();
    FieldConfig::create([
      'field_name' => $field_name,
      'entity_type' => 'node',
      'bundle' => 'kb_page',
    ] + ($options['field'] ?? []))->save();
  }

}
