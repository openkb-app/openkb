<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * The per-space moderation policy, on the config the recipe actually ships.
 *
 * `field_moderation` on a space, read and answered per page by
 * SpaceModerationPolicy — the input the commit surface and the
 * moderation-status endpoint branch on.
 *
 * The publish half of the feature is not here, because it is not code: the
 * recipe grants the publish transition to `authenticated` and the space
 * boundary is the ordinary update rule, exercised end to end in
 * \Drupal\Tests\openkb_agent\Functional\SpaceModerationCommitTest.
 *
 * @group openkb_space_access
 */
final class SpaceModerationTest extends KernelTestBase {

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
    'openkb_space',
    'workflows',
    'content_moderation',
    'openkb_space_access',
  ];

  /**
   * A space that moderates: saves land as drafts.
   */
  private SpaceInterface $moderated;

  /**
   * A space that does not: saves publish.
   */
  private SpaceInterface $wiki;

  /**
   * On the manager roster of both spaces.
   */
  private UserInterface $manager;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('content_moderation_state');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['filter', 'node']);

    $this->importRecipeConfig([
      'node.type.kb_page',
      'field.storage.node.field_type',
      'field.storage.node.field_space',
      'field.field.node.kb_page.field_type',
      'field.field.node.kb_page.field_space',
      'field.storage.openkb_space.field_moderation',
      'field.field.openkb_space.openkb_space.field_moderation',
      'workflows.workflow.editorial',
    ]);

    // User 1 is the superuser and bypasses everything; burn it on a
    // placeholder so no account under test inherits that.
    User::create(['name' => 'superuser'])->save();

    // A stand-in for the recipe's `authenticated`, holding what an editing
    // session needs. The policy under test reads no permission at all — the
    // account exists only to sit on a space's manager roster.
    $role = Role::create(['id' => 'kb_user', 'label' => 'KB user']);
    foreach ([
      'access content',
      'create kb_page content',
      'edit own kb_page content',
      'use editorial transition create_new_draft',
      'use editorial transition publish',
    ] as $permission) {
      $role->grantPermission($permission);
    }
    $role->save();

    $this->manager = $this->createUser('manager', $role->id());

    $this->moderated = $this->createSpace('Handbook', TRUE);
    $this->wiki = $this->createSpace('Scratchpad', FALSE);
  }

  /**
   * The flag defaults to moderated, however it is left unset.
   *
   * A space written without the field — one created by something that does not
   * know about the flag — must keep review rather than silently start
   * publishing on save.
   */
  public function testMissingModerationFlagReadsAsModerated(): void {
    $unset = Space::create(['label' => 'Unset']);
    $unset->save();

    $policy = \Drupal::service('openkb_space_access.moderation_policy');
    $this->assertTrue($policy->isModerated($unset));
    $this->assertTrue($policy->isModerated($this->moderated));
    $this->assertFalse($policy->isModerated($this->wiki));
  }

  /**
   * The policy answers per page, from the page's own space.
   */
  public function testPolicyFollowsThePagesSpace(): void {
    $policy = \Drupal::service('openkb_space_access.moderation_policy');

    $this->assertTrue($policy->applies($this->createPage('Onboarding', $this->moderated)));
    $this->assertFalse($policy->applies($this->createPage('Notes', $this->wiki)));

    // No space, no flag to have turned anything off: the bundle's own workflow
    // stands.
    $this->assertTrue($policy->applies($this->createPage('Loose page', NULL)));
  }

  /**
   * A flag flip is effective immediately, in both directions.
   *
   * The settings UI writes the space over JSON:API and the very next commit
   * has to obey the new policy — same request, no cache to wait out.
   */
  public function testModerationFlipIsEffectiveImmediately(): void {
    $policy = \Drupal::service('openkb_space_access.moderation_policy');
    $page = $this->createPage('Onboarding', $this->moderated);

    $this->moderated->set('field_moderation', 0);
    $this->moderated->save();
    $this->assertFalse($policy->applies($page));

    $this->moderated->set('field_moderation', 1);
    $this->moderated->save();
    $this->assertTrue($policy->applies($page));
  }

  /**
   * Creates a space with the manager on its roster.
   */
  private function createSpace(string $name, bool $moderated): SpaceInterface {
    $space = Space::create([
      'label' => $name,
      'read_access' => 'all_users',
      'field_moderation' => $moderated ? 1 : 0,
      'managers' => [['target_id' => $this->manager->id()]],
    ]);
    $space->save();
    return $space;
  }

  /**
   * Creates an enabled user with one role.
   */
  private function createUser(string $name, string $role): UserInterface {
    $user = User::create(['name' => $name, 'status' => 1]);
    $user->addRole($role);
    $user->save();
    return $user;
  }

  /**
   * Creates a published page, in a space or outside every space.
   */
  private function createPage(string $title, ?SpaceInterface $space): NodeInterface {
    $values = [
      'type' => 'kb_page',
      'title' => $title,
      'field_type' => 'article',
      'moderation_state' => 'published',
    ];
    if ($space !== NULL) {
      $values['field_space'] = ['target_id' => $space->id()];
    }
    $page = Node::create($values);
    $page->save();
    return $page;
  }

}
