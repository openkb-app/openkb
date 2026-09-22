<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\node\Entity\Node;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;

/**
 * The structural contract of a space's outline, on the shipped recipe config.
 *
 * The outline is the whole page tree of a space in one `string_long` base
 * field on the space, so a drag is one space PATCH and no page is touched.
 * What holds that JSON to a shape is a pair of field constraints rather than
 * the write endpoint's own parsing — the shape is the space's own rule, the
 * membership rule needs a node query and is this module's. These assertions go
 * through plain entity validation, so whatever writes the field (the tree UI,
 * a JSON:API PATCH, an agent, drush) meets exactly this.
 *
 * @group openkb_space_access
 */
final class SpaceOutlineTest extends KernelTestBase {

  use RecipeConfigTrait;

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
    'openkb_space_access',
  ];

  /**
   * The space the outline under test belongs to.
   */
  private SpaceInterface $space;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    // Re-saving a page rewrites its grants.
    $this->installSchema('node', ['node_access']);

    $this->importRecipeConfig($this->kbPageConfigNames());

    $this->space = Space::create(['label' => 'Engineering']);
    $this->space->save();
  }

  /**
   * The outline field is a single-value JSON sidecar on the space alone.
   *
   * Structure is context, not page metadata: no page carries a parent
   * or a weight, which is what keeps a move off the node save path entirely.
   */
  public function testOutlineLivesOnTheSpaceAlone(): void {
    $space_fields = \Drupal::service('entity_field.manager')
      ->getFieldDefinitions('openkb_space', 'openkb_space');
    $this->assertArrayHasKey('outline', $space_fields);
    $this->assertSame('string_long', $space_fields['outline']->getType());
    $this->assertSame(1, $space_fields['outline']->getFieldStorageDefinition()->getCardinality());

    $page_fields = \Drupal::service('entity_field.manager')
      ->getFieldDefinitions('node', 'kb_page');
    $this->assertArrayNotHasKey('field_parent', $page_fields);
    $this->assertArrayNotHasKey('field_weight', $page_fields);
    $this->assertArrayNotHasKey('field_outline', $page_fields);
  }

  /**
   * An empty outline is valid — a space starts with no structure at all.
   */
  public function testEmptyOutlineValidates(): void {
    $this->assertSame([], $this->violations(NULL));
    $this->assertSame([], $this->violations(''));
    $this->assertSame([], $this->violations('[]'));
  }

  /**
   * A well-formed tree of this space's own pages validates, at any depth.
   */
  public function testNestedTreeOfOwnPagesValidates(): void {
    $root = $this->page('Root');
    $child = $this->page('Child');
    $grandchild = $this->page('Grandchild');

    $outline = [
      [
        'id' => $root->uuid(),
        'children' => [
          [
            'id' => $child->uuid(),
            'children' => [['id' => $grandchild->uuid()]],
          ],
        ],
      ],
    ];
    $this->assertSame([], $this->violations(json_encode($outline)));
  }

  /**
   * Not-JSON never reaches storage.
   */
  public function testMalformedJsonIsRejected(): void {
    $this->assertNotEmpty($this->violations('{not json'));
    // A JSON object is parseable but is not a sibling list.
    $this->assertNotEmpty($this->violations('{"id": "x"}'));
  }

  /**
   * Entries must be objects carrying a non-empty string id.
   */
  public function testMalformedEntriesAreRejected(): void {
    $this->assertNotEmpty($this->violations('["a-bare-string"]'));
    $this->assertNotEmpty($this->violations('[{"id": ""}]'));
    $this->assertNotEmpty($this->violations('[{"children": []}]'));
    $this->assertNotEmpty($this->violations(
      '[{"id": "' . $this->page('A')->uuid() . '", "children": {"nope": 1}}]',
    ));
  }

  /**
   * One page cannot sit in two places — which is also the cycle guard.
   *
   * Re-parenting a node under its own descendant would leave it listed twice,
   * so the duplicate rule is what keeps a dragged subtree from swallowing
   * itself; no separate ancestor walk is needed.
   */
  public function testDuplicateIdIsRejected(): void {
    $page = $this->page('Twice');
    $outline = [
      ['id' => $page->uuid()],
      ['id' => $page->uuid()],
    ];
    $this->assertNotEmpty($this->violations(json_encode($outline)));

    $nested = [
      [
        'id' => $page->uuid(),
        'children' => [['id' => $page->uuid()]],
      ],
    ];
    $this->assertNotEmpty($this->violations(json_encode($nested)));
  }

  /**
   * The tree may only hold pages of this very space.
   *
   * A foreign page would render in a space its own grants never covered,
   * and an unknown UUID is a stale id the read-side sweep drops anyway.
   */
  public function testForeignAndUnknownPagesAreRejected(): void {
    $other_space = Space::create(['label' => 'Product']);
    $other_space->save();
    $foreign = $this->page('Elsewhere', $other_space);

    $this->assertNotEmpty($this->violations(json_encode([['id' => $foreign->uuid()]])));
    $this->assertNotEmpty($this->violations(
      json_encode([['id' => '11111111-2222-3333-4444-555555555555']]),
    ));

    // Nesting does not smuggle one in either.
    $mine = $this->page('Mine');
    $this->assertNotEmpty($this->violations(json_encode([
      ['id' => $mine->uuid(), 'children' => [['id' => $foreign->uuid()]]],
    ])));
  }

  /**
   * Moving a page between spaces invalidates the old space's outline.
   *
   * The tree stays authoritative about membership: the stale entry has to be
   * dropped rather than silently rendering a page that left.
   */
  public function testOutlineFollowsPageSpaceReassignment(): void {
    $page = $this->page('Movable');
    $outline = json_encode([['id' => $page->uuid()]]);
    $this->assertSame([], $this->violations($outline));

    $other_space = Space::create(['label' => 'Product']);
    $other_space->save();
    $page->set('field_space', $other_space->id())->save();

    $this->assertNotEmpty($this->violations($outline));
  }

  /**
   * Validates an outline value against the space.
   *
   * @param string|null $json
   *   The raw field value.
   *
   * @return string[]
   *   The violation messages, so an empty array reads as "accepted".
   */
  private function violations(?string $json): array {
    $this->space->set('outline', $json);
    $messages = [];
    foreach ($this->space->validate() as $violation) {
      $messages[] = (string) $violation->getMessage();
    }
    return $messages;
  }

  /**
   * Creates a kb_page in a space (this test's space by default).
   */
  private function page(string $title, ?SpaceInterface $space = NULL): Node {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'field_space' => ($space ?? $this->space)->id(),
    ]);
    $page->save();
    return $page;
  }

}
