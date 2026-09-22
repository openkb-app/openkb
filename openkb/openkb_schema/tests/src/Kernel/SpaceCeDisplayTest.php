<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_schema\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\node\Entity\Node;
use Drupal\openkb_space\Entity\Space;
use Symfony\Component\Yaml\Yaml;

/**
 * Asserts a kb_page page response carries its space as an object.
 *
 * The space is context the read surface renders — the breadcrumb names it and
 * links to it — so the page response has to carry it. `field_space` goes
 * through the `entity_ce_render` formatter against the space's own CE display,
 * which makes `props.space` the space itself: uuid, id, name, readAccess. A
 * bare entity id would leave every reader resolving it against a second
 * request.
 *
 * The shipped recipe YAML is what gets imported here, so a regression in the
 * files — a dropped formatter setting, a renamed view mode, a prop leaving the
 * space display — fails on this test rather than in a browser.
 *
 * @group openkb_schema
 */
final class SpaceCeDisplayTest extends KernelTestBase {

  use RecipeConfigTrait;
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
    'path',
    'path_alias',
    'custom_elements',
    'openkb_space',
    // Owns the `boolean` formatter the space display asks for.
    'openkb_schema',
  ];

  /**
   * The reader every render runs as.
   */
  private AccountInterface $reader;

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
    // `node` brings the core `full` view mode the page display renders in;
    // the space's path prop is its alias.
    $this->installConfig(['field', 'system', 'user', 'node', 'taxonomy']);

    $this->importRecipeConfig([
      'node.type.kb_page',
      'field.storage.node.field_space',
      'field.field.node.kb_page.field_space',
      'field.storage.openkb_space.description',
      'field.field.openkb_space.openkb_space.description',
      'field.storage.openkb_space.field_moderation',
      'field.field.openkb_space.openkb_space.field_moderation',
      'field.storage.openkb_space.field_agent_review',
      'field.field.openkb_space.openkb_space.field_agent_review',
      'core.entity_view_mode.openkb_space.full',
      'core.entity_view_mode.openkb_space.custom_elements_space',
      'custom_elements.entity_ce_display.openkb_space.openkb_space.full',
      'custom_elements.entity_ce_display.openkb_space.openkb_space.custom_elements_space',
      'custom_elements.entity_ce_display.node.kb_page.full',
    ]);

    // `field_space` carries the space only when the reader may view it, so the
    // page props assert against a reader who may.
    $this->reader = $this->setUpCurrentUser([], ['access content']);
  }

  /**
   * The space display carries identity, not a render tree.
   *
   * Every prop is a bare scalar, because a consumer reads them — it does not
   * render them. `path` is the space's path alias: its own URL, rather than
   * one the frontend derives from the name.
   */
  public function testSpaceDisplayRendersTheSpaceIdentity(): void {
    $space = Space::create([
      'label' => 'Engineering',
      'read_access' => 'all_users',
      'field_moderation' => FALSE,
      'field_agent_review' => TRUE,
    ]);
    $space->save();

    $element = $this->container->get('custom_elements.generator')
      ->generate($space, 'custom_elements_space');

    $this->assertSame('kb-space', $element->getPrefixedTag());
    // Key order is not a contract; the key set and the values are.
    $this->assertEquals([
      'uuid' => $space->uuid(),
      'id' => (string) $space->id(),
      'name' => 'Engineering',
      'path' => '/engineering',
      'readAccess' => 'all_users',
      'moderation' => FALSE,
      'agentReview' => TRUE,
    ], $element->getAttributes());
  }

  /**
   * The landing display carries what the space's own page is built from.
   *
   * The space's path alias is answered from this display: the frontend renders
   * it as the space page, and reads the roster and settings under the slug the
   * alias carries.
   */
  public function testLandingDisplayCarriesTheSpacePage(): void {
    $space = Space::create([
      'label' => 'Engineering',
      'description' => 'How the platform is built and run.',
      'read_access' => 'all_users',
      'field_moderation' => FALSE,
      'field_agent_review' => TRUE,
    ]);
    $space->save();

    $element = $this->container->get('custom_elements.generator')
      ->generate($space, 'full');

    $this->assertSame('kb-space', $element->getPrefixedTag());
    $this->assertEquals([
      'name' => 'Engineering',
      'path' => '/engineering',
      'description' => 'How the platform is built and run.',
    ], $element->getAttributes());
  }

  /**
   * The space review policy travels as real booleans, not as strings.
   */
  public function testReviewPolicyPropsAreBooleans(): void {
    $space = Space::create([
      'label' => 'Team Wiki',
      'read_access' => 'all_users',
      'field_moderation' => FALSE,
      'field_agent_review' => TRUE,
    ]);
    $space->save();

    // Load from storage: only then does the boolean come back as a string.
    $loaded = $this->container->get('entity_type.manager')
      ->getStorage('openkb_space')
      ->loadUnchanged($space->id());

    $attributes = $this->container->get('custom_elements.generator')
      ->generate($loaded, 'custom_elements_space')
      ->getAttributes();

    $this->assertFalse($attributes['moderation']);
    $this->assertTrue($attributes['agentReview']);

    // The frontend parses the JSON encoding, so pin the encoded types too.
    $decoded = Json::decode(Json::encode($attributes));
    $this->assertFalse($decoded['moderation']);
    $this->assertTrue($decoded['agentReview']);
  }

  /**
   * A page's page response carries the space object on `props.space`.
   *
   * This is the whole point of the ticket: one round-trip. Whatever names or
   * links the space on the read page reads it from here.
   */
  public function testPageCarriesTheSpaceObject(): void {
    $space = Space::create([
      'label' => 'Engineering',
      'read_access' => 'members_only',
      'viewers' => [['target_id' => $this->reader->id()]],
      'field_moderation' => TRUE,
      'field_agent_review' => FALSE,
    ]);
    $space->save();

    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Deploying',
      'field_space' => $space->id(),
    ]);
    $page->save();

    $element = $this->container->get('custom_elements.generator')
      ->generate($page, 'full');
    $space_prop = $element->getAttribute('space');

    $this->assertIsArray($space_prop);
    // No `element` key: the space is a prop value here, not a nested element
    // anyone renders — that is what `hide_element` buys.
    $this->assertArrayNotHasKey('element', $space_prop);
    $this->assertEquals([
      'uuid' => $space->uuid(),
      'id' => (string) $space->id(),
      'name' => 'Engineering',
      'path' => '/engineering',
      'readAccess' => 'members_only',
      'moderation' => TRUE,
      'agentReview' => FALSE,
    ], $space_prop);
    // The types must survive nesting inside the page response too.
    $this->assertTrue($space_prop['moderation']);
    $this->assertFalse($space_prop['agentReview']);
  }

  /**
   * The shipped page display asks for the rendered space, not an entity id.
   *
   * Asserted on the YAML as well as through a render, so the settings that
   * shape the output — which display to render, and dropping the `element`
   * key — cannot drift silently.
   */
  public function testPageDisplayConfiguresTheRenderedReference(): void {
    $display = Yaml::parseFile($this->recipeConfigPath('custom_elements.entity_ce_display.node.kb_page.full'));

    $this->assertSame('entity_ce_render', $display['content']['space']['formatter']);
    $this->assertSame('field_space', $display['content']['space']['field_name']);
    $this->assertFalse($display['content']['space']['is_slot']);
    $this->assertSame([
      'mode' => 'custom_elements_space',
      'flatten' => 0,
      'hide_element' => TRUE,
    ], $display['content']['space']['configuration']);
    $this->assertContains(
      'field.field.node.kb_page.field_space',
      $display['dependencies']['config'],
    );
  }

}
