<?php

declare(strict_types=1);

namespace Drupal\Tests\simple_oauth_personal_consumers\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\simple_oauth\Entity\Oauth2Scope;
use Drupal\simple_oauth\Entity\Oauth2Token;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;

/**
 * Personal consumer provisioning, token stamping, and revocation.
 *
 * @group simple_oauth_personal_consumers
 */
final class PersonalConsumerManagerTest extends KernelTestBase {

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
    'serialization',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
  ];

  /**
   * The manager under test.
   */
  protected PersonalConsumerManagerInterface $manager;

  /**
   * The owner account.
   */
  protected User $owner;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installConfig(['user', 'simple_oauth', 'simple_oauth_personal_consumers']);

    Oauth2Scope::create([
      'id' => 'test_read',
      'name' => 'test:read',
      'description' => 'Read access.',
      'grant_types' => ['client_credentials' => ['status' => TRUE]],
      'umbrella' => FALSE,
      'granularity_id' => 'permission',
      'granularity_configuration' => ['permission' => 'access content'],
    ])->save();
    $this->config('simple_oauth_personal_consumers.settings')
      ->set('scopes', ['test_read'])
      ->save();

    // Seed the super-user (uid 1) as Drupal's installer does, so the plain
    // owner below gets uid 2 — uid 1 is refused as an administrator.
    User::create(['uid' => 1, 'name' => 'root', 'status' => 1])->save();

    $this->owner = User::create(['name' => 'fago', 'status' => 1]);
    $this->owner->save();

    $this->manager = $this->container->get('simple_oauth_personal_consumers.manager');
  }

  /**
   * Creates an oauth2_token entity for the given consumer.
   */
  protected function createToken(int $consumer_id): Oauth2Token {
    /** @var \Drupal\simple_oauth\Entity\Oauth2Token $token */
    // Mirrors TokenEntityNormalizer's create values for the
    // client_credentials grant: auth_user_id explicitly NULL, which
    // suppresses the current-user default the entity would otherwise apply.
    $token = Oauth2Token::create([
      'bundle' => 'access_token',
      'auth_user_id' => NULL,
      'client' => $consumer_id,
      'scopes' => ['test_read'],
      'value' => $this->randomMachineName(32),
      'expire' => time() + 300,
    ]);
    $token->save();
    return $token;
  }

  /**
   * Provisioning binds the consumer to the owner with the configured cap.
   */
  public function testCreate(): void {
    $credentials = $this->manager->create($this->owner, 'Claude');
    $consumer = $credentials->consumer;

    $this->assertSame('Claude', $consumer->label());
    $this->assertSame($this->owner->id(), $consumer->get('user_id')->target_id);
    $this->assertTrue((bool) $consumer->get('personal')->value);
    $this->assertTrue((bool) $consumer->get('confidential')->value);
    $this->assertSame([['value' => 'client_credentials']], $consumer->get('grant_types')->getValue());
    $this->assertSame('test_read', $consumer->get('scopes')->scope_id);

    // The secret is hashed at rest; the plaintext exists only in the result.
    $this->assertNotSame($credentials->secret, $consumer->get('secret')->value);
    $this->assertTrue($this->container->get('password')->check($credentials->secret, $consumer->get('secret')->value));

    $this->assertEquals([$consumer->id()], array_keys($this->manager->getConsumers($this->owner)));
    $this->assertFalse($this->manager->isRevoked($consumer));

    $this->expectException(\InvalidArgumentException::class);
    $this->manager->create(User::getAnonymousUser(), 'Claude');
  }

  /**
   * One name, one of the owner's agents.
   *
   * The name is half the key work is assigned by, so two agents of one person
   * under one name would each answer the other's assignments. Per owner, and
   * on the name as it reads rather than as it is typed.
   */
  public function testEachAgentNeedsItsOwnName(): void {
    $claude = $this->manager->create($this->owner, 'claude')->consumer;

    $this->assertTrue($this->manager->nameTaken($this->owner, 'claude'));
    $this->assertTrue($this->manager->nameTaken($this->owner, 'CLAUDE'), 'case is not a difference');
    $this->assertTrue($this->manager->nameTaken($this->owner, '  claude  '), 'nor is the space around it');
    $this->assertFalse($this->manager->nameTaken($this->owner, 'codex'));
    // Its own name is its own to keep.
    $this->assertFalse($this->manager->nameTaken($this->owner, 'claude', $claude));

    // Somebody else's agent may be called the same thing: the assignment key
    // carries the owner.
    $other = User::create(['name' => 'ada', 'status' => 1]);
    $other->save();
    $this->assertFalse($this->manager->nameTaken($other, 'claude'));

    // A revoked client keeps its name — the api-clients page still lists it,
    // and everything it wrote still reads as its name.
    $this->manager->revoke($claude);
    $this->assertTrue($this->manager->nameTaken($this->owner, 'claude'));

    $this->assertSame(
      'You already have an agent named claude. Choose another name.',
      strip_tags((string) $this->manager->nameTakenError(' claude ')),
    );
  }

  /**
   * Admin accounts cannot own a personal consumer.
   *
   * A token acts as its owner and inherits the admin bypass; admins are
   * refused so a client can never sidestep its scope ceiling. The refusal
   * covers both an admin role and the super-user (uid 1).
   */
  public function testAdminOwnerRefused(): void {
    Role::create(['id' => 'boss', 'label' => 'Boss', 'is_admin' => TRUE])->save();
    $admin = User::create(['name' => 'boss', 'status' => 1]);
    $admin->addRole('boss');
    $admin->save();
    $this->assertTrue($this->manager->isAdminAccount($admin));

    // The super-user (uid 1) is an admin regardless of its roles.
    $this->assertTrue($this->manager->isAdminAccount(User::load(1)));

    // A plain user is not.
    $this->assertFalse($this->manager->isAdminAccount($this->owner));

    $this->expectException(\InvalidArgumentException::class);
    $this->manager->create($admin, 'Claude');
  }

  /**
   * Personal consumers' tokens are stamped with the owner; others untouched.
   */
  public function testTokenOwnerStamp(): void {
    $credentials = $this->manager->create($this->owner, 'Claude');
    $token = $this->createToken((int) $credentials->consumer->id());
    $this->assertEquals($this->owner->id(), $token->get('auth_user_id')->target_id);

    // A non-personal consumer's client_credentials token keeps an empty
    // auth_user_id — simple_oauth's stock behavior stays untouched.
    /** @var \Drupal\consumers\Entity\ConsumerInterface $plain */
    $plain = $this->container->get('entity_type.manager')->getStorage('consumer')->create([
      'label' => 'Plain',
      'client_id' => 'plain',
      'secret' => 'plain-secret',
      'grant_types' => ['client_credentials'],
      'confidential' => TRUE,
      'user_id' => $this->owner->id(),
    ]);
    $plain->save();
    $plain_token = $this->createToken((int) $plain->id());
    $this->assertTrue($plain_token->get('auth_user_id')->isEmpty());
  }

  /**
   * Revoking kills tokens and issuance but keeps the consumer entity.
   */
  public function testRevoke(): void {
    $credentials = $this->manager->create($this->owner, 'Claude');
    $consumer = $credentials->consumer;
    $token = $this->createToken((int) $consumer->id());

    $this->manager->revoke($consumer);

    $token_storage = $this->container->get('entity_type.manager')->getStorage('oauth2_token');
    $token_storage->resetCache();
    // The manager revokes the tokens; on top, simple_oauth's consumer-update
    // handling may delete them outright. Either way the token is dead.
    /** @var \Drupal\simple_oauth\Entity\Oauth2Token|null $token */
    $token = $token_storage->load($token->id());
    $this->assertTrue($token === NULL || $token->isRevoked());

    $this->assertTrue($this->manager->isRevoked($consumer));
    $this->assertTrue($consumer->get('grant_types')->isEmpty());
    // The entity survives, still listed for the owner.
    $this->assertEquals([$consumer->id()], array_keys($this->manager->getConsumers($this->owner)));
  }

}
