<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_space\Entity\Space;

/**
 * The space's alias survives beside pathauto.
 *
 * Pages are aliased by pathauto, which swaps core's path item for its own
 * on every entity type — and that one drops an alias it did not generate. A
 * space says it generates its own, and this is what holds it to that.
 *
 * @group openkb_space
 */
final class SpaceAliasWithPathautoTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'options',
    'path_alias',
    'path',
    'token',
    'pathauto',
    'views',
    'openkb_space',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installConfig(['system', 'pathauto']);
  }

  /**
   * The name is still the alias, and a rename still moves it.
   */
  public function testTheAliasIsWrittenWithPathautoInstalled(): void {
    $space = Space::create(['label' => 'Team Wiki']);
    $space->save();
    $this->assertSame('/team-wiki', $this->alias($space));
    $this->assertSame('team-wiki', $space->getSlug());

    $space->set('label', 'Product Handbook')->save();
    $this->assertSame('/product-handbook', $this->alias($space));
  }

  /**
   * The alias the storage holds for a space's canonical path.
   */
  private function alias(Space $space): string {
    return $this->container->get('path_alias.manager')
      ->getAliasByPath('/openkb-space/' . $space->id());
  }

}
