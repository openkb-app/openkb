<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_demo_lupus_docs\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Recipe\Recipe;
use Drupal\openkb_workflow\PageBlocks;
use Drupal\Core\Recipe\RecipeRunner;
use Drupal\KernelTests\KernelTestBase;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\SpaceInterface;
use Drupal\user\Entity\User;

/**
 * Applies the shipped recipe and asserts the demo space it leaves behind.
 *
 * The whole recipe, sub-recipes and all: under test is the seam between the
 * default content and the install hook that writes the page tree and the
 * pending draft onto it. The hook then runs a second time, since a recipe is
 * re-appliable and a block id two blocks answer to can be cited by neither.
 *
 * @group openkb_demo_lupus_docs
 */
final class LupusDocsDemoTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = ['system', 'user', 'field', 'filter', 'text', 'node', 'taxonomy'];

  /**
   * The 52 pinned source pages plus one generated landing per section.
   *
   * Spelled out rather than counted off the recipe: the generator writes both
   * sides of that comparison, so it would agree with itself after dropping a
   * page.
   */
  private const PAGES = 58;

  /**
   * Top-level entries of the page tree: 6 sections and 2 standalone pages.
   */
  private const OUTLINE_ROOTS = 8;

  /**
   * The generator's own record of what it wrote, as the install hook reads it.
   */
  private array $seed;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    // A recipe installs its modules as syncing, and Drupal skips a syncing
    // module's config *entities* — so the view modes and roles the recipe's
    // own config depends on have to be in place before it runs.
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('taxonomy_term');
    $this->installSchema('node', 'node_access');
    $this->installConfig(['system', 'user', 'filter', 'node', 'taxonomy']);
    // Core's default-content importer runs as uid 1, which the demo space
    // carries on its managers roster.
    User::create(['uid' => 0, 'name' => ''])->save();
    User::create(['uid' => 1, 'name' => 'admin', 'status' => 1])->save();

    $path = dirname(DRUPAL_ROOT) . '/recipes/openkb_recipe_demo_lupus_docs';
    RecipeRunner::processRecipe(Recipe::createFromDirectory($path));

    $this->seed = Json::decode(file_get_contents(
      dirname(DRUPAL_ROOT) . '/openkb/openkb_demo_lupus_docs/demo-content.json'
    ));
  }

  /**
   * The space carries the roster, the review setting and the page tree.
   */
  public function testSpace(): void {
    $space = $this->space();

    self::assertSame('Lupus Decoupled Docs', $space->label());
    self::assertSame('all_users', $space->get('read_access')->value);
    self::assertTrue((bool) $space->get('field_moderation')->value);

    self::assertSame(['editor1'], $this->names($space, 'managers', ['admin']));
    self::assertSame(['editor2'], $this->names($space, 'members'));

    $outline = Json::decode($space->get('outline')->value);
    self::assertSame($this->seed['outline'], $outline);
    self::assertCount(self::OUTLINE_ROOTS, $outline);
    self::assertCount(self::PAGES, $this->outlineNodes($outline));
  }

  /**
   * Every generated page is a page of the space.
   *
   * And every block in one is addressable by an id no other block answers to.
   */
  public function testPages(): void {
    $pages = $this->pages();
    self::assertCount(self::PAGES, $pages);
    self::assertCount(self::PAGES, $this->generatedPageFiles());

    $blocks = \Drupal::service('openkb_workflow.page_blocks');
    $seen = [];
    foreach ($pages as $page) {
      $ids = array_keys($blocks->segment($page->get('field_kb_body')->value));
      self::assertNotEmpty($ids, sprintf('%s has no addressable block.', $page->label()));
      $seen = array_merge($seen, $ids);
    }
    self::assertSame(array_unique($seen), $seen, 'Two blocks share an id.');
  }

  /**
   * One page carries editor2's block as a draft waiting for editor1.
   */
  public function testPendingDraft(): void {
    $page = $this->draftPage();
    $blocks = \Drupal::service('openkb_workflow.page_blocks');
    $id = $this->seed['draft']['block'];

    self::assertSame('published', $page->get('moderation_state')->value);
    self::assertArrayNotHasKey($id, $blocks->segment($page->get('field_kb_body')->value));

    $latest = $this->latestRevision($page);
    self::assertFalse($latest->isDefaultRevision());
    self::assertSame('draft', $latest->get('moderation_state')->value);
    self::assertArrayHasKey($id, $blocks->segment($latest->get('field_kb_body')->value));

    $sidecar = $blocks->decode($latest->get('field_block_meta')->value);
    self::assertTrue($blocks->isPending($sidecar[$id], PageBlocks::STEP_PEER));
  }

  /**
   * A second apply of the install hook changes nothing.
   */
  public function testReapplyIsIdempotent(): void {
    $blocks = \Drupal::service('openkb_workflow.page_blocks');
    $before = $this->latestRevision($this->draftPage());
    $body = $before->get('field_kb_body')->value;
    $outline = $this->space()->get('outline')->value;

    \Drupal::moduleHandler()->loadInclude('openkb_demo_lupus_docs', 'install');
    openkb_demo_lupus_docs_install();

    self::assertCount(self::PAGES, $this->pages());
    self::assertSame($outline, $this->space()->get('outline')->value);

    $after = $this->latestRevision($this->draftPage());
    self::assertSame($body, $after->get('field_kb_body')->value);
    self::assertSame($before->getRevisionId(), $after->getRevisionId());
    self::assertSame([], $blocks->changed($after->get('field_kb_body')->value, $body));
  }

  /**
   * The page files the generator wrote into the recipe.
   *
   * @return string[]
   *   The file paths.
   */
  private function generatedPageFiles(): array {
    $dir = dirname(DRUPAL_ROOT) . '/recipes/openkb_recipe_demo_lupus_docs_pages/content/kb_page';
    return glob($dir . '/*.yml') ?: [];
  }

  /**
   * Every node of a page tree, roots and children alike.
   *
   * @param array $nodes
   *   The tree, as nested `{id, children}` nodes.
   *
   * @return string[]
   *   The node UUIDs.
   */
  private function outlineNodes(array $nodes): array {
    $ids = [];
    foreach ($nodes as $node) {
      $ids[] = $node['id'];
      $ids = array_merge($ids, $this->outlineNodes($node['children'] ?? []));
    }
    return $ids;
  }

  /**
   * The demo space.
   */
  private function space(): SpaceInterface {
    return $this->loadByUuid('openkb_space', $this->seed['space']);
  }

  /**
   * The page the draft was seeded on.
   */
  private function draftPage(): NodeInterface {
    return $this->loadByUuid('node', $this->seed['draft']['page']);
  }

  /**
   * Every page the space holds.
   *
   * @return \Drupal\node\NodeInterface[]
   *   The pages.
   */
  private function pages(): array {
    return \Drupal::entityTypeManager()->getStorage('node')->loadByProperties([
      'type' => 'kb_page',
      'field_space' => $this->space()->id(),
    ]);
  }

  /**
   * The latest revision of a page, default or not.
   */
  private function latestRevision(NodeInterface $page): NodeInterface {
    $storage = \Drupal::entityTypeManager()->getStorage('node');
    return $storage->loadRevision($storage->getLatestRevisionId($page->id()));
  }

  /**
   * The account names a roster field lists, sorted, minus the ones given.
   *
   * The default content puts the applying account, uid 1, on the managers
   * roster, so the recipe's own entry is what is left once it is taken out.
   *
   * @param \Drupal\openkb_space\SpaceInterface $space
   *   The space.
   * @param string $field
   *   The roster field name.
   * @param string[] $except
   *   Account names to leave out.
   *
   * @return list<string>
   *   The names.
   */
  private function names(SpaceInterface $space, string $field, array $except = []): array {
    $names = [];
    foreach ($space->get($field)->referencedEntities() as $account) {
      $names[] = $account->getAccountName();
    }
    $names = array_values(array_diff($names, $except));
    sort($names);
    return $names;
  }

  /**
   * The single entity with this UUID.
   */
  private function loadByUuid(string $entity_type, string $uuid) {
    $matches = \Drupal::entityTypeManager()
      ->getStorage($entity_type)
      ->loadByProperties(['uuid' => $uuid]);
    self::assertCount(1, $matches, sprintf('No single %s %s.', $entity_type, $uuid));
    return reset($matches);
  }

}
