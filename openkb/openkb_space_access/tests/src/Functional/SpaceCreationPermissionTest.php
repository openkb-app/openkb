<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Functional;

use Drupal\Tests\BrowserTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;

/**
 * The recipe's own grant lists, resolved against the real permission registry.
 *
 * `drupalCreateUser()` rejects a permission no enabled module defines, so
 * building both accounts out of `recipeGrantedPermissions()` is what proves
 * every name in recipe.yml is real — a recipe that names a missing permission
 * fails on apply, which is a broken install rather than a failing test.
 *
 * With that established, the assertion the list is really about: everything a
 * signed-in account is handed, opening a space among it.
 *
 * @group openkb_space_access
 */
final class SpaceCreationPermissionTest extends BrowserTestBase {

  use RecipeConfigTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'node',
    'field',
    'text',
    'filter',
    'options',
    'taxonomy',
    'openkb_space',
    // Every module that defines a permission the recipe grants: media for the
    // editor's image dialog, path for the alias in-app creation writes,
    // content_moderation for the editorial transitions, and personal consumers
    // for the agent tokens a user manages.
    'media',
    'path',
    'workflows',
    'content_moderation',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_space_access',
  ];

  /**
   * {@inheritdoc}
   */
  protected $defaultTheme = 'stark';

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->rebuildAll();
  }

  /**
   * A signed-in account writes pages and opens spaces.
   */
  public function testTheRecipeGrantsWritingAndSpaceCreation(): void {
    $handler = $this->container->get('entity_type.manager')
      ->getAccessControlHandler('openkb_space');

    $member = $this->drupalCreateUser($this->recipeGrantedPermissions('authenticated'));

    $this->assertTrue($member->hasPermission('edit any kb_page content'));
    $this->assertTrue($handler->createAccess(NULL, $member));
    $this->assertFalse($handler->createAccess(NULL, $this->drupalCreateUser()));
  }

}
