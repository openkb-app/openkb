<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\node\Entity\Node;
use Drupal\openkb_space\Entity\Space;
use Drupal\user\Entity\User;

/**
 * A space rename moves the pages that nest under it.
 *
 * `pathauto.pattern.kb_page` builds a page's alias from its space's,
 * and re-derives it only when the page itself is saved. The rename hook is
 * what keeps the space's pages reachable under the name it now answers to.
 *
 * @group openkb_space_access
 */
final class SpaceRenameCarriesPagesTest extends KernelTestBase {

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
    'path_alias',
    'path',
    'token',
    'pathauto',
    'openkb_space',
    'openkb_space_access',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['filter', 'node', 'system', 'pathauto']);

    $this->importRecipeConfig([
      'node.type.kb_page',
      'field.storage.node.field_space',
      'field.field.node.kb_page.field_space',
      'pathauto.pattern.kb_page',
    ]);

    User::create(['name' => 'superuser'])->save();
  }

  /**
   * The pages follow the space's new URL; a rename to the same slug is not.
   */
  public function testThePagesFollowTheRename(): void {
    $space = Space::create(['label' => 'Team Handbook']);
    $space->save();
    $page = $this->page($space, 'Onboarding Guide');

    $this->assertSame('/team-handbook/onboarding-guide', $this->alias($page));

    $space->set('label', 'Team Handbook 2')->save();
    $this->assertSame('/team-handbook-2/onboarding-guide', $this->alias($page));

    // A name that cleans to the same URL leaves the page where it is.
    $space->set('label', 'Team  Handbook  2')->save();
    $this->assertSame('/team-handbook-2/onboarding-guide', $this->alias($page));
  }

  /**
   * A page of another space keeps its own prefix.
   */
  public function testOnlyTheRenamedSpacesPagesMove(): void {
    $handbook = Space::create(['label' => 'Team Handbook']);
    $handbook->save();
    $wiki = Space::create(['label' => 'Team Wiki']);
    $wiki->save();
    $elsewhere = $this->page($wiki, 'Getting Started');

    $handbook->set('label', 'Team Handbook 2')->save();

    $this->assertSame('/team-wiki/getting-started', $this->alias($elsewhere));
  }

  /**
   * A page with a hand-set alias keeps it through a rename.
   */
  public function testHandSetPageAliasSurvives(): void {
    $space = Space::create(['label' => 'Team Handbook']);
    $space->save();
    $page = $this->page($space, 'Onboarding Guide');
    $page->set('path', ['alias' => '/onboarding', 'pathauto' => 0])->save();

    $space->set('label', 'Team Handbook 2')->save();

    $this->assertSame('/onboarding', $this->alias($page));
  }

  /**
   * A page in the space, aliased by pathauto.
   */
  private function page(Space $space, string $title): Node {
    $node = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'field_space' => ['target_id' => $space->id()],
      'uid' => 1,
    ]);
    $node->save();
    return $node;
  }

  /**
   * The alias the storage holds for an entity's canonical path.
   */
  private function alias(Node $node): string {
    return $this->container->get('path_alias.manager')
      ->getAliasByPath('/node/' . $node->id());
  }

}
