<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_schema\Kernel;

use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Field\FieldStorageDefinitionInterface;
use Drupal\KernelTests\KernelTestBase;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\user\Entity\User;
use Symfony\Component\Yaml\Yaml;

/**
 * Asserts the shipped `field_space` recipe config keeps space out of editing.
 *
 * Unlike SchemaEndpointTest (which builds a programmatic model), this test
 * imports the *actual* openkb_recipe_main config YAML so a regression in the
 * shipped files — a dropped required flag, the wrong target entity type, or
 * the field slipping back into the frontmatter form display — fails here.
 *
 * The space is context, not page metadata: it is required on every page
 * and set by the surface a page is created in, never hand-edited in the
 * frontmatter form. Absence from the `frontmatter` form display is what keeps
 * it out of the schema, the editor form and the `.md` projection — the same
 * zero-code exposure contract, read in reverse.
 *
 * @group openkb_schema
 */
final class RecipeSpaceFieldTest extends KernelTestBase {

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
    'path_alias',
    'path',
    'openkb_space',
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
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');

    $this->importRecipeConfig([
      'taxonomy.vocabulary.kb_tags',
      'node.type.kb_page',
      'field.storage.node.field_type',
      'field.storage.node.field_summary',
      'field.storage.node.field_owner',
      'field.storage.node.field_contributors',
      'field.storage.node.field_tags',
      'field.storage.node.field_space',
      'field.field.node.kb_page.field_type',
      'field.field.node.kb_page.field_summary',
      'field.field.node.kb_page.field_owner',
      'field.field.node.kb_page.field_contributors',
      'field.field.node.kb_page.field_tags',
      'field.field.node.kb_page.field_space',
      'core.entity_form_mode.node.frontmatter',
      'core.entity_form_display.node.kb_page.frontmatter',
    ]);
  }

  /**
   * The space stays out of the frontmatter schema, the editor and the `.md`.
   *
   * Moving a page between spaces is a deliberate action of its own, not a
   * field on the page form — so the field is absent from the frontmatter
   * form display, and everything derived from that display follows.
   */
  public function testSpaceStaysOutOfTheFrontmatterSchema(): void {
    /** @var \Drupal\openkb_schema\SchemaBuilder $builder */
    $builder = $this->container->get('openkb_schema.schema_builder');
    $schema = $builder->build(new CacheableMetadata());

    $this->assertArrayNotHasKey('space', $schema['properties']);
    $this->assertNotContains('space', $schema['required'] ?? []);
    // The rest of the contract is untouched — this is one field leaving, not
    // the exposure pipeline changing.
    $this->assertArrayHasKey('type', $schema['properties']);
    $this->assertArrayHasKey('summary', $schema['properties']);
  }

  /**
   * The space is required on the bundle and editable on the backend form.
   *
   * Out of the frontmatter form is not out of the model: `node/add` still
   * needs a widget, because that is a creation surface which has to carry a
   * space like every other one.
   */
  public function testSpaceIsRequiredAndKeptOnTheBackendForm(): void {
    $definitions = \Drupal::service('entity_field.manager')
      ->getFieldDefinitions('node', 'kb_page');
    $this->assertArrayHasKey('field_space', $definitions);
    $this->assertTrue($definitions['field_space']->isRequired());
    $this->assertSame(
      'openkb_space',
      $definitions['field_space']->getFieldStorageDefinition()->getSetting('target_type'),
    );

    // Read the shipped default display as YAML: it references widgets from
    // modules this kernel test does not install.
    $default = Yaml::parseFile(
      dirname(DRUPAL_ROOT) . '/recipes/openkb_recipe_main/config/core.entity_form_display.node.kb_page.default.yml',
    );
    $this->assertArrayHasKey('field_space', $default['content']);

    $frontmatter = \Drupal::entityTypeManager()->getStorage('entity_form_display')
      ->load('node.kb_page.frontmatter');
    $this->assertNull($frontmatter->getComponent('field_space'));
  }

  /**
   * A page without a space does not validate — no creation path skips it.
   */
  public function testPageWithoutSpaceFailsValidation(): void {
    $space = Space::create(['label' => 'General']);
    $space->save();

    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Spaceless',
    ]);
    $this->assertContains('field_space', $this->violatingFields($page));

    $page->set('field_space', $space->id());
    $this->assertNotContains('field_space', $this->violatingFields($page));
  }

  /**
   * The field names a validation run complains about.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to validate.
   *
   * @return string[]
   *   Field names, so unrelated required fields do not affect the assertion.
   */
  private function violatingFields(NodeInterface $page): array {
    $fields = [];
    foreach ($page->validate() as $violation) {
      $fields[] = explode('.', $violation->getPropertyPath())[0];
    }
    return $fields;
  }

  /**
   * The roster lives on the space, in three unlimited user references.
   *
   * Membership is space metadata, not page metadata: the fields belong to
   * the space entity and must stay out of the page frontmatter, or every
   * page edit would carry a roster.
   */
  public function testRosterFieldsLiveOnTheSpace(): void {
    $definitions = \Drupal::service('entity_field.manager')
      ->getFieldDefinitions('openkb_space', 'openkb_space');

    foreach (['managers', 'members', 'viewers'] as $field_name) {
      $this->assertArrayHasKey($field_name, $definitions);
      $storage = $definitions[$field_name]->getFieldStorageDefinition();
      $this->assertSame('entity_reference', $storage->getType());
      $this->assertSame('user', $storage->getSetting('target_type'));
      $this->assertSame(
        FieldStorageDefinitionInterface::CARDINALITY_UNLIMITED,
        $storage->getCardinality(),
      );
    }

    $page_fields = \Drupal::service('entity_field.manager')
      ->getFieldDefinitions('node', 'kb_page');
    $this->assertArrayNotHasKey('managers', $page_fields);
    $this->assertArrayNotHasKey('members', $page_fields);
    $this->assertArrayNotHasKey('viewers', $page_fields);
  }

  /**
   * A space holds a whole roster, and a user sits in exactly one of the fields.
   */
  public function testRosterRoundTripsOnTheSpace(): void {
    $reader = User::create(['name' => 'reader']);
    $reader->save();
    $writer = User::create(['name' => 'writer']);
    $writer->save();

    $space = Space::create([
      'label' => 'General',
      'viewers' => [$reader->id()],
      'managers' => [$writer->id()],
    ]);
    $space->save();

    $space = $this->loadSpace($space->id());
    $this->assertSame([(string) $reader->id()], array_column($space->get('viewers')->getValue(), 'target_id'));
    $this->assertSame([(string) $writer->id()], array_column($space->get('managers')->getValue(), 'target_id'));

    // A role change moves the reference rather than duplicating it — the shape
    // the members form PATCHes.
    $space->set('viewers', []);
    $space->set('managers', [$writer->id(), $reader->id()]);
    $space->save();

    $space = $this->loadSpace($space->id());
    $this->assertSame([], $space->get('viewers')->getValue());
    $this->assertCount(2, $space->get('managers')->getValue());
  }

  /**
   * Re-reads a space from storage.
   */
  private function loadSpace(string|int $id): Space {
    /** @var \Drupal\openkb_space\Entity\Space $space */
    $space = \Drupal::entityTypeManager()->getStorage('openkb_space')->loadUnchanged($id);
    return $space;
  }

  /**
   * Creates config entities from openkb_recipe_main/config/*.yml files.
   *
   * @param string[] $names
   *   Config names in dependency order.
   */
  private function importRecipeConfig(array $names): void {
    $dir = dirname(DRUPAL_ROOT) . '/recipes/openkb_recipe_main/config';
    $config_manager = \Drupal::service('config.manager');
    $entity_type_manager = \Drupal::entityTypeManager();
    foreach ($names as $name) {
      $data = Yaml::parseFile("$dir/$name.yml");
      // Options fields: the API expects the [value => label] map, not
      // the export shape.
      if (isset($data['settings']['allowed_values'])) {
        $data['settings']['allowed_values'] = array_column($data['settings']['allowed_values'], 'label', 'value');
      }
      $entity_type_id = $config_manager->getEntityTypeIdByName($name);
      $entity_type_manager->getStorage($entity_type_id)->create($data)->save();
    }
  }

}
