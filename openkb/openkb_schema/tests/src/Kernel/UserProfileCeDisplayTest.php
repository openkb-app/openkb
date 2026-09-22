<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_schema\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\user\Entity\User;
use Symfony\Component\Yaml\Yaml;

/**
 * Asserts the account page at `/user/<uid>` has something to render.
 *
 * A presence avatar leads there, as does the account menu's own link. Without
 * a CE display the route answers a bare `user` element with no props, which is
 * a blank page — so this asserts on the shipped recipe YAML, and a prop
 * leaving it fails here rather than in a browser.
 *
 * Rendered in the `full` mode the canonical route uses, against the `default`
 * display: `default` answers every view mode that has none of its own.
 *
 * @group openkb_schema
 */
final class UserProfileCeDisplayTest extends KernelTestBase {

  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'custom_elements',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installConfig(['field', 'system', 'user']);

    $data = Yaml::parseFile(dirname(DRUPAL_ROOT)
      . '/recipes/openkb_recipe_main/config/custom_elements.entity_ce_display.user.user.default.yml');
    \Drupal::entityTypeManager()->getStorage('entity_ce_display')->create($data)->save();

    // The permission the recipe grants every authenticated account — a name is
    // only readable to somebody who may look at profiles at all.
    $this->setUpCurrentUser([], ['access user profiles']);
  }

  /**
   * The profile carries who the account is, and nothing else.
   */
  public function testProfileCarriesTheAccountIdentity(): void {
    $account = User::create(['name' => 'fago']);
    $account->save();

    $element = $this->container->get('custom_elements.generator')->generate($account, 'full');

    $this->assertSame('user-profile', $element->getPrefixedTag());
    // Key order is not a contract; the key set and the values are.
    $this->assertEquals([
      'uid' => (string) $account->id(),
      'name' => 'fago',
    ], $element->getAttributes());
  }

}
