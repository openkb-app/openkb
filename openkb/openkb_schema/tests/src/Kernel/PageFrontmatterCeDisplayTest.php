<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_schema\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\node\Entity\Node;
use Drupal\taxonomy\Entity\Term;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\user\Entity\User;
use Symfony\Component\Yaml\Yaml;

/**
 * Pins the page CE display against the frontmatter exposure contract.
 *
 * A published `.md` — and `tool_api__get_page` — projects its frontmatter
 * straight
 * off `props` of the `kb_page` page response, keyed by frontmatter key. The
 * exposure contract is still the `frontmatter` form display (SchemaBuilder), so
 * the two displays have to agree: a field placed in the form display with no
 * prop of its own on the CE display would be published as permanently empty.
 *
 * References carry a `uuid` and a raw `label`: SchemaBuilder declares a
 * reference to be `{id, label}` with the id a UUID, and the internal id the
 * formatter emits beside it cannot be written back.
 *
 * @group openkb_schema
 */
final class PageFrontmatterCeDisplayTest extends KernelTestBase {

  use UserCreationTrait;

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
    'custom_elements',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('taxonomy_term');
    $this->installConfig(['field', 'system', 'user', 'node', 'taxonomy']);

    $this->importRecipeConfig([
      'taxonomy.vocabulary.kb_tags',
      'node.type.kb_page',
      'field.storage.node.field_type',
      'field.field.node.kb_page.field_type',
      'field.storage.node.field_summary',
      'field.field.node.kb_page.field_summary',
      'field.storage.node.field_owner',
      'field.field.node.kb_page.field_owner',
      'field.storage.node.field_contributors',
      'field.field.node.kb_page.field_contributors',
      'field.storage.node.field_tags',
      'field.field.node.kb_page.field_tags',
      'core.entity_form_mode.node.frontmatter',
      'core.entity_form_display.node.kb_page.frontmatter',
      'custom_elements.entity_ce_display.node.kb_page.full',
    ]);

    // Reference props carry the referenced entity only when the reader may
    // view it, so the props assert against a reader who may — the permissions
    // an authenticated KB reader holds.
    $this->setUpCurrentUser([], ['access content', 'access user profiles']);
  }

  /**
   * Every exposed field has a CE prop named after its frontmatter key.
   *
   * Asserted on the shipped YAML, so exposing a field in the form display
   * without publishing it fails here rather than as a blank line in someone's
   * `.md`.
   */
  public function testEveryExposedFieldIsPublishedUnderItsFrontmatterKey(): void {
    $form_display = $this->recipeConfig('core.entity_form_display.node.kb_page.frontmatter');
    $ce_display = $this->recipeConfig('custom_elements.entity_ce_display.node.kb_page.full');

    foreach (array_keys($form_display['content']) as $field_name) {
      $key = substr($field_name, strlen('field_'));
      $this->assertArrayHasKey($key, $ce_display['content'], "No CE prop for exposed field $field_name.");
      $this->assertSame($field_name, $ce_display['content'][$key]['field_name']);
      $this->assertFalse($ce_display['content'][$key]['is_slot']);
    }
  }

  /**
   * A rendered page carries every frontmatter value on its props.
   */
  public function testPagePropsCarryTheFrontmatterValues(): void {
    // Active accounts: core denies view access on a blocked user, and a
    // reference the reader may not view carries no prop.
    $owner = User::create(['name' => 'marta', 'status' => 1]);
    $owner->save();
    $contributor = User::create(['name' => 'jon', 'status' => 1]);
    $contributor->save();
    $tag = Term::create(['vid' => 'kb_tags', 'name' => 'platform']);
    $tag->save();

    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Deploying',
      'field_type' => 'runbook',
      'field_summary' => 'How a release ships.',
      'field_owner' => $owner->id(),
      'field_contributors' => [$contributor->id()],
      'field_tags' => [$tag->id()],
    ]);
    $page->save();

    $props = $this->container->get('custom_elements.generator')
      ->generate($page, 'full')
      ->getAttributes();

    $this->assertSame('runbook', $props['type']);
    $this->assertSame('How a release ships.', $props['summary']);
    // Single-value references ship one object, multi-value ones a list — the
    // shape difference the frontmatter codec already makes.
    $this->assertSame($owner->uuid(), $props['owner']['uuid']);
    $this->assertSame('marta', $props['owner']['label']);
    $this->assertSame([$contributor->uuid()], array_column($props['contributors'], 'uuid'));
    $this->assertSame(['jon'], array_column($props['contributors'], 'label'));
    $this->assertSame([$tag->uuid()], array_column($props['tags'], 'uuid'));
    $this->assertSame(['platform'], array_column($props['tags'], 'label'));
  }

  /**
   * An empty field ships no prop at all — consumers read that as null/[].
   */
  public function testAnEmptyFieldShipsNoProp(): void {
    $page = Node::create(['type' => 'kb_page', 'title' => 'Bare']);
    $page->save();

    $props = $this->container->get('custom_elements.generator')
      ->generate($page, 'full')
      ->getAttributes();

    foreach (['summary', 'owner', 'contributors', 'tags'] as $key) {
      $this->assertArrayNotHasKey($key, $props);
    }
  }

  /**
   * Parsed YAML of a config shipped by openkb_recipe_main.
   */
  private function recipeConfig(string $name): array {
    return Yaml::parseFile(dirname(DRUPAL_ROOT) . "/recipes/openkb_recipe_main/config/$name.yml");
  }

  /**
   * Creates config entities from openkb_recipe_main/config/*.yml files.
   *
   * @param string[] $names
   *   Config names in dependency order.
   */
  private function importRecipeConfig(array $names): void {
    $config_manager = \Drupal::service('config.manager');
    $entity_type_manager = \Drupal::entityTypeManager();
    foreach ($names as $name) {
      $data = $this->recipeConfig($name);
      // Options fields: the API expects the [value => label] map, not the
      // export shape.
      if (isset($data['settings']['allowed_values'])) {
        $data['settings']['allowed_values'] = array_column($data['settings']['allowed_values'], 'label', 'value');
      }
      $entity_type_id = $config_manager->getEntityTypeIdByName($name);
      $entity_type_manager->getStorage($entity_type_id)->create($data)->save();
    }
  }

}
