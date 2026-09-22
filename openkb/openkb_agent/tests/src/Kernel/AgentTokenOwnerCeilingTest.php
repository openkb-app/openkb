<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\Core\Session\AccountInterface;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\simple_oauth\Authentication\TokenAuthUser;
use Drupal\simple_oauth\Entity\Oauth2Token;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * A token never exceeds its owner (ADR 0002).
 *
 * The ceiling is an intersection, not a grant: an agent token carries its
 * owner in `auth_user_id`, and simple_oauth's Oauth2AccessPolicy answers such a
 * token with `owner's calculated permissions ∩ the scopes' permissions`. So a
 * scope naming `edit any kb_page content` hands that permission to nobody —
 * it only allows an owner who already holds it to use it through the token.
 * Every OpenKB agent token is owner-bound: personal consumers stamp the
 * consumer's owner onto each token, the authorization-code grant stamps whoever
 * consented.
 *
 * Pinned here because the property is invisible in the config: the scope file
 * reads like a grant and the difference only shows against an owner who lacks
 * the permission the scope names.
 *
 * @group openkb_agent
 */
final class AgentTokenOwnerCeilingTest extends KernelTestBase {

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
    'path',
    'path_alias',
    'file',
    'image',
    'serialization',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_space',
    'openkb_space_access',
  ];

  /**
   * The permission the write ceiling names.
   */
  private const NAMED_BY_THE_SCOPE = 'edit any kb_page content';

  /**
   * An owner on the members roster of one space and no other.
   */
  private UserInterface $editor;

  /**
   * An owner holding the site-wide edit permission the scope names.
   */
  private UserInterface $wideEditor;

  /**
   * Readable to every signed-in user, with nobody under test on its roster.
   */
  private SpaceInterface $openSpace;

  /**
   * The space the editor is a member of.
   */
  private SpaceInterface $editorSpace;

  /**
   * A page the editor may not update — it sits in the open space.
   */
  private NodeInterface $unwritablePage;

  /**
   * A page the editor may update — it sits in their own space.
   */
  private NodeInterface $writablePage;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['filter', 'node', 'user', 'simple_oauth', 'simple_oauth_personal_consumers']);

    $this->importRecipeConfig([
      'node.type.kb_page',
      'field.storage.node.field_type',
      'field.storage.node.field_space',
      'field.field.node.kb_page.field_type',
      'field.field.node.kb_page.field_space',
      'filter.format.comark',
    ]);
    $this->importRecipeConfig($this->agentConfigNames());
    $this->applyAgentScopeSettings();

    // Burn uid 1: the super-user bypasses everything and is refused as an
    // owner anyway.
    User::create(['name' => 'superuser', 'status' => 1])->save();

    // An owner without the permission the scope names.
    $this->editor = $this->createUserWithPermissions('editor1', [
      'access content',
      'create kb_page content',
      'edit own kb_page content',
      'use text format comark',
    ]);
    // The same owner, holding it.
    $this->wideEditor = $this->createUserWithPermissions('editor2', [
      'access content',
      'create kb_page content',
      'edit own kb_page content',
      'use text format comark',
      self::NAMED_BY_THE_SCOPE,
    ]);

    $this->openSpace = Space::create([
      'label' => 'General',
      'read_access' => 'all_users',
    ]);
    $this->openSpace->save();

    $this->editorSpace = Space::create([
      'label' => 'Handbook',
      'read_access' => 'all_users',
      'members' => [['target_id' => $this->editor->id()]],
    ]);
    $this->editorSpace->save();

    $this->unwritablePage = $this->createPage('Company handbook', $this->openSpace);
    $this->writablePage = $this->createPage('Team runbook', $this->editorSpace);
  }

  /**
   * The token is refused exactly where its owner is, and writes where they do.
   *
   * The open space is readable to every signed-in user, so the editor sees the
   * page and still may not write it: the roster, not the read setting,
   * decides. Both halves against one token, because the ceiling is only
   * meaningful as a pair — a cap that also refuses the legitimate write is a
   * broken agent, not a safe one.
   */
  public function testTokenWritesExactlyWhereItsOwnerMay(): void {
    $token = $this->tokenUser($this->editor);

    $this->assertTrue($this->access($this->unwritablePage, 'view', $token));
    $this->assertFalse($this->access($this->unwritablePage, 'update', $this->editor));
    $this->assertFalse($this->access($this->unwritablePage, 'update', $token));

    $this->assertTrue($this->access($this->writablePage, 'update', $this->editor));
    $this->assertTrue($this->access($this->writablePage, 'update', $token));
  }

  /**
   * Answers an entity access check for one account.
   *
   * The handler's own cache is keyed by account id, and a token shares the id
   * of its owner — so without the reset the second half of every pair below
   * reads the first half's answer.
   */
  private function access(NodeInterface $node, string $operation, AccountInterface $account): bool {
    $this->container->get('entity_type.manager')
      ->getAccessControlHandler('node')
      ->resetCache();

    return $node->access($operation, $account);
  }

  /**
   * The scope names a permission; only the owner's roles hand it out.
   *
   * `agent:write:content` names `edit any kb_page content` for both tokens
   * below. The one whose owner holds it keeps it, the other never gets it.
   */
  public function testTheScopeCannotGrantWhatTheOwnerLacks(): void {
    $this->assertFalse($this->editor->hasPermission(self::NAMED_BY_THE_SCOPE));
    $this->assertFalse($this->tokenUser($this->editor)->hasPermission(self::NAMED_BY_THE_SCOPE));

    $this->assertTrue($this->wideEditor->hasPermission(self::NAMED_BY_THE_SCOPE));
    $this->assertTrue($this->tokenUser($this->wideEditor)->hasPermission(self::NAMED_BY_THE_SCOPE));
  }

  /**
   * Builds a live personal-consumer token for an owner and wraps it.
   */
  private function tokenUser(UserInterface $owner): TokenAuthUser {
    $credentials = $this->container->get('simple_oauth_personal_consumers.manager')
      ->create($owner, 'Claude');
    $token = Oauth2Token::create([
      'bundle' => 'access_token',
      // Explicit NULL suppresses the entity's current-user default so the
      // personal-consumer stamp fills auth_user_id from the consumer owner.
      'auth_user_id' => NULL,
      'client' => $credentials->consumer->id(),
      'scopes' => ['agent_read', 'agent_write'],
      'value' => $this->randomMachineName(32),
      'expire' => time() + 300,
    ]);
    $token->save();
    // The stamp is what makes the ceiling an intersection: without it
    // simple_oauth hands the scopes' permissions over outright.
    $this->assertEquals($owner->id(), $token->get('auth_user_id')->target_id);

    return new TokenAuthUser(
      $this->container->get('permission_checker'),
      $token,
      $this->container->get('psr7.http_message_factory'),
      $this->container->get('request_stack'),
    );
  }

  /**
   * Creates an account holding exactly the given permissions.
   */
  private function createUserWithPermissions(string $name, array $permissions): UserInterface {
    $role = Role::create(['id' => $name . '_role', 'label' => $name]);
    foreach ($permissions as $permission) {
      $role->grantPermission($permission);
    }
    $role->save();

    $user = User::create(['name' => $name, 'status' => 1]);
    $user->addRole($role->id());
    $user->save();

    return $user;
  }

  /**
   * Creates a published page in a space, authored by nobody under test.
   */
  private function createPage(string $title, SpaceInterface $space): NodeInterface {
    $node = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'field_type' => 'article',
      'field_space' => ['target_id' => $space->id()],
      'uid' => 1,
      'status' => 1,
    ]);
    $node->save();

    return $node;
  }

}
