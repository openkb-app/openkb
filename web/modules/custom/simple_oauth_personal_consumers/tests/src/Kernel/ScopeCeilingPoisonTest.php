<?php

declare(strict_types=1);

namespace Drupal\Tests\simple_oauth_personal_consumers\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\node\Entity\NodeType;
use Drupal\simple_oauth\Authentication\TokenAuthUser;
use Drupal\simple_oauth\Entity\Oauth2Scope;
use Drupal\simple_oauth\Entity\Oauth2Token;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;

/**
 * The scope ceiling survives calculated-permissions cache poisoning.
 *
 * A personal-consumer token shares the id of its owner subject
 * (TokenAuthUser::id() === subject id). Core's AccessPolicyProcessor resolves
 * cache contexts from the global current_user but computes permissions for the
 * passed account, and its account-switch guard keys on id equality — so a token
 * and its own subject are indistinguishable to the cache. When the plain owner
 * User's permissions are computed during a token-authenticated request,
 * simple_oauth's Oauth2AccessPolicy skips the scope intersection (the account
 * is not a TokenAuthUser) and the owner's full permissions land in the token's
 * scope cache-key. A later genuine token request then reads the poisoned entry.
 *
 * This models the deployed condition the fresh-install matrix test misses:
 * cold, the token computes its intersected entry first and the ceiling holds;
 * only a prior non-token computation of the owner under a token current-user
 * exposes the bypass.
 *
 * @group simple_oauth_personal_consumers
 */
final class ScopeCeilingPoisonTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'file',
    'image',
    'options',
    'text',
    'filter',
    'node',
    'serialization',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
  ];

  /**
   * A permission the scope grants (owner has it too).
   */
  private const IN_SCOPE = 'access content';

  /**
   * A permission the owner holds but no scope grants.
   */
  private const OUT_OF_SCOPE = 'edit any page content';

  /**
   * The token's owner subject.
   */
  protected User $owner;

  /**
   * A live token bound to the owner, capped at the read scope.
   */
  protected Oauth2Token $token;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installConfig(['user', 'simple_oauth', 'simple_oauth_personal_consumers']);

    // The 'edit any page content' permission is only defined once its node type
    // exists.
    NodeType::create(['type' => 'page', 'name' => 'Page'])->save();

    Oauth2Scope::create([
      'id' => 'test_read',
      'name' => 'test:read',
      'description' => self::IN_SCOPE,
      'grant_types' => ['client_credentials' => ['status' => TRUE]],
      'umbrella' => FALSE,
      'granularity_id' => 'permission',
      'granularity_configuration' => ['permission' => self::IN_SCOPE],
    ])->save();
    $this->config('simple_oauth_personal_consumers.settings')
      ->set('scopes', ['test_read'])
      ->save();

    // Seed the super-user (uid 1) as Drupal's installer does, so the owner
    // below gets uid 2 — uid 1 is refused as a personal-consumer owner.
    User::create(['uid' => 1, 'name' => 'root', 'status' => 1])->save();

    // The owner holds an out-of-scope permission on top of the read one.
    $role = Role::create(['id' => 'author', 'label' => 'Author']);
    $role->grantPermission(self::IN_SCOPE)->grantPermission(self::OUT_OF_SCOPE)->save();
    $this->owner = User::create(['name' => 'fago', 'status' => 1]);
    $this->owner->addRole('author');
    $this->owner->save();

    $credentials = $this->container->get('simple_oauth_personal_consumers.manager')
      ->create($this->owner, 'Claude');
    $this->token = Oauth2Token::create([
      'bundle' => 'access_token',
      // Explicit NULL suppresses the entity's current-user default so the
      // personal-consumer stamp fills auth_user_id from the consumer owner.
      'auth_user_id' => NULL,
      'client' => $credentials->consumer->id(),
      'scopes' => ['test_read'],
      'value' => $this->randomMachineName(32),
      'expire' => time() + 300,
    ]);
    $this->token->save();
    $this->assertEquals($this->owner->id(), $this->token->get('auth_user_id')->target_id);
  }

  /**
   * Builds the TokenAuthUser wrapper for the owner-bound token.
   */
  protected function tokenUser(): TokenAuthUser {
    return new TokenAuthUser(
      $this->container->get('permission_checker'),
      $this->token,
      $this->container->get('psr7.http_message_factory'),
      $this->container->get('request_stack'),
    );
  }

  /**
   * Whether the token's calculated permissions grant a permission.
   */
  protected function tokenGrants(string $permission): bool {
    $item = $this->container->get('access_policy_processor')
      ->processAccessPolicies($this->tokenUser())
      ->getItem();
    return $item && $item->hasPermission($permission);
  }

  /**
   * Cold, the ceiling holds: in-scope granted, out-of-scope denied.
   */
  public function testColdCeiling(): void {
    $this->assertTrue($this->tokenGrants(self::IN_SCOPE), 'Owner ∩ scope grants the read permission.');
    $this->assertFalse($this->tokenGrants(self::OUT_OF_SCOPE), 'The out-of-scope permission is denied cold.');
  }

  /**
   * The ceiling survives a poisoning owner computation under the token.
   */
  public function testPoisonedCeiling(): void {
    $token_user = $this->tokenUser();
    $processor = $this->container->get('access_policy_processor');
    $switcher = $this->container->get('account_switcher');

    // Poison: with the token as current user, compute the plain owner's
    // permissions — the exact interaction a live site performs when attributing
    // or access-checking the owner during a token request. This must not cache
    // the owner's full permissions under the token's scope cache-key.
    $switcher->switchTo($token_user);
    try {
      $processor->processAccessPolicies($this->owner);
    }
    finally {
      $switcher->switchBack();
    }

    // A genuine token request must still be capped at owner ∩ scope.
    $this->assertTrue($this->tokenGrants(self::IN_SCOPE), 'The in-scope permission survives.');
    $this->assertFalse(
      $this->tokenGrants(self::OUT_OF_SCOPE),
      'The scope ceiling holds after a poisoning owner computation.',
    );
  }

}
