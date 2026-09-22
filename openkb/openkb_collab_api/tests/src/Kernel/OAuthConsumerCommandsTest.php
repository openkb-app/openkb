<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_collab_api\Kernel;

use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\openkb_collab_api\Drush\Commands\OAuthConsumerCommands;
use Drupal\user\Entity\Role;
use Drupal\user\UserInterface;

/**
 * Provisioning an OAuth consumer from a deployment's environment.
 *
 * The command runs on every deploy, so what it does to a consumer that is
 * already there is the whole of its behaviour: it has to converge on what the
 * environment now says — a rotated secret above all — and it has to refuse the
 * inputs that would leave a permanently dead client behind.
 *
 * @group openkb_collab_api
 */
final class OAuthConsumerCommandsTest extends KernelTestBase {

  use RecipeConfigTrait;
  use UserCreationTrait;

  private const LABEL = 'Collaboration server';
  private const CLIENT_ID = 'collab-client';

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'file',
    'image',
    // consumer's grant_types is a list_string.
    'options',
    'serialization',
    'consumers',
    'simple_oauth',
    // openkb_agent's consent screen reads the account's own clients through it.
    'simple_oauth_personal_consumers',
    // This module's commit resource inherits jsonapi.entity_resource and
    // consumes the review model, so the container needs both present.
    'node',
    'taxonomy',
    'jsonapi',
    'path',
    'path_alias',
    'openkb_space_access',
    'openkb_agent',
    'openkb_workflow',
    'openkb_schema',
    'openkb_collab_api',
  ];

  /**
   * The command under test.
   */
  private OAuthConsumerCommands $commands;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('file');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installConfig(['system', 'field', 'user']);
    // User 1 is a superuser; take it out of circulation.
    $this->createUser();

    Role::create(['id' => 'collab_server', 'label' => 'Collaboration server'])->save();
    $this->commands = new OAuthConsumerCommands(
      $this->container->get('entity_type.manager'),
      $this->container->get('password_generator'),
    );
  }

  /**
   * A first run provisions the consumer and the account it acts as.
   */
  public function testItProvisionsTheConsumerAndItsServiceUser(): void {
    $this->provision(['secret' => 'first-secret']);

    $consumer = $this->consumer();
    $this->assertSame(self::LABEL, $consumer->label(), 'named as the site names it, with no self-asserted marking');
    // The site provisioned this client, so the consent screen has nothing to
    // warn about — unlike one that registered itself.
    $this->assertFalse((bool) $consumer->get('third_party')->value);
    $this->assertTrue($this->secretMatches('first-secret', $consumer));
    $this->assertSame(['client_credentials'], array_column($consumer->get('grant_types')->getValue(), 'value'));

    $user = $this->serviceUser();
    $this->assertSame((string) $user->id(), $consumer->get('user_id')->target_id);
    $this->assertContains('collab_server', $user->getRoles());
  }

  /**
   * A re-run with a rotated secret rehashes it.
   *
   * So the site accepts the secret the environment now holds.
   */
  public function testTheRotatedSecretReachesTheSite(): void {
    $this->provision(['secret' => 'first-secret']);
    $this->provision(['secret' => 'rotated-secret']);

    $this->assertCount(1, $this->entityTypeManager()->getStorage('consumer')
      ->loadByProperties(['client_id' => self::CLIENT_ID]));
    $consumer = $this->consumer();
    $this->assertTrue($this->secretMatches('rotated-secret', $consumer));
    $this->assertFalse($this->secretMatches('first-secret', $consumer));
  }

  /**
   * A re-run puts the service account back on the role it needs.
   */
  public function testItEnsuresTheRoleOnAnExistingServiceUser(): void {
    $this->provision(['secret' => 'first-secret']);
    $user = $this->serviceUser();
    $user->removeRole('collab_server');
    $user->save();

    $this->provision(['secret' => 'first-secret']);

    $this->assertContains('collab_server', $this->serviceUser()->getRoles());
  }

  /**
   * An empty required option is refused, not turned into a dead client.
   *
   * `self::REQ` only means the option takes a value, so an unset environment
   * variable arrives as an empty string.
   *
   * @dataProvider emptyOptions
   */
  public function testAnEmptyRequiredOptionThrows(array $options, string $expected): void {
    $this->expectException(\InvalidArgumentException::class);
    $this->expectExceptionMessage($expected);
    try {
      $this->provision($options);
    }
    finally {
      $this->assertSame([], $this->entityTypeManager()->getStorage('consumer')->loadMultiple());
    }
  }

  /**
   * Each required option, empty.
   */
  public static function emptyOptions(): array {
    return [
      'client id' => [['client-id' => ''], '--client-id is required'],
      'secret' => [['secret' => ''], '--secret is required'],
      'user' => [['user' => ''], '--user is required'],
      'role' => [['role' => ''], '--role is required'],
    ];
  }

  /**
   * The secret can be named rather than passed, keeping it out of argv.
   */
  public function testTheSecretCanComeFromTheEnvironment(): void {
    putenv('OKB_TEST_CLIENT_SECRET=secret-from-the-environment');
    try {
      $this->provision(['secret' => NULL, 'secret-env' => 'OKB_TEST_CLIENT_SECRET']);
    }
    finally {
      putenv('OKB_TEST_CLIENT_SECRET');
    }

    $this->assertTrue($this->secretMatches('secret-from-the-environment', $this->consumer()));
  }

  /**
   * A re-run converges the scopes, dropping the ones it no longer names.
   */
  public function testItConvergesTheScopes(): void {
    $this->importRecipeConfig(['simple_oauth.oauth2_scope.collab']);

    $this->provision(['scopes' => 'collab']);
    $this->assertSame(['collab'], $this->scopeIds());

    $this->provision(['scopes' => NULL]);
    $this->assertSame([], $this->scopeIds());
  }

  /**
   * One client id on two consumers is refused, not converged at random.
   */
  public function testTwoConsumersOnOneClientIdThrow(): void {
    $this->provision([]);
    $this->entityTypeManager()->getStorage('consumer')->create([
      'client_id' => self::CLIENT_ID,
      'label' => 'A second consumer',
      'secret' => 'another-secret',
    ])->save();

    $this->expectException(\RuntimeException::class);
    $this->expectExceptionMessage('is on more than one consumer');
    $this->provision([]);
  }

  /**
   * The scope ids on the provisioned consumer.
   *
   * @return string[]
   *   The ids, in stored order.
   */
  private function scopeIds(): array {
    return array_column($this->consumer()->get('scopes')->getValue(), 'scope_id');
  }

  /**
   * Runs the command with the collaboration server's options.
   */
  private function provision(array $overrides): void {
    $this->commands->createOauthConsumer(self::LABEL, $overrides + [
      'client-id' => self::CLIENT_ID,
      'secret' => 'a-secret',
      'secret-env' => NULL,
      'user' => 'collab_server',
      'role' => 'collab_server',
      'scopes' => NULL,
      'grant-types' => 'client_credentials',
    ]);
  }

  /**
   * The provisioned consumer.
   */
  private function consumer(): ConsumerInterface {
    $storage = $this->entityTypeManager()->getStorage('consumer');
    $storage->resetCache();
    $consumers = $storage->loadByProperties(['client_id' => self::CLIENT_ID]);
    $this->assertNotEmpty($consumers, 'The consumer was provisioned.');
    return reset($consumers);
  }

  /**
   * The service account the consumer acts as.
   */
  private function serviceUser(): UserInterface {
    $storage = $this->entityTypeManager()->getStorage('user');
    $storage->resetCache();
    $users = $storage->loadByProperties(['name' => 'collab_server']);
    $this->assertNotEmpty($users, 'The service user was created.');
    return reset($users);
  }

  /**
   * Whether the stored hash is one of the given plaintext secret.
   */
  private function secretMatches(string $secret, ConsumerInterface $consumer): bool {
    return $this->container->get('password')
      ->check($secret, (string) $consumer->get('secret')->value);
  }

  /**
   * The entity type manager.
   */
  private function entityTypeManager(): EntityTypeManagerInterface {
    return $this->container->get('entity_type.manager');
  }

}
