<?php

declare(strict_types=1);

namespace Drupal\Tests\simple_oauth_personal_consumers\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\simple_oauth\Entity\Oauth2Token;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use Drupal\user\Entity\User;

/**
 * What a consumer's age stamps are, and what cron does with them.
 *
 * @group simple_oauth_personal_consumers
 */
final class UnclaimedConsumerSweepTest extends KernelTestBase {

  private const RETENTION = 604800;

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
  private PersonalConsumerManagerInterface $manager;

  /**
   * The request time every age in this suite is measured from.
   */
  private int $now;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installConfig(['system', 'user', 'simple_oauth', 'simple_oauth_personal_consumers']);

    $this->manager = $this->container->get('simple_oauth_personal_consumers.manager');
    $this->now = $this->container->get('datetime.time')->getRequestTime();

    // Seed the super-user (uid 1) as Drupal's installer does, so accounts
    // created below are plain users — uid 1 cannot own a personal consumer.
    User::create(['uid' => 1, 'name' => 'root', 'status' => 1])->save();
  }

  /**
   * Creates an account.
   */
  private function createUser(): User {
    $user = User::create(['name' => $this->randomMachineName(), 'status' => 1]);
    $user->save();
    return $user;
  }

  /**
   * Creates a self-registered personal consumer of the given age.
   */
  private function createConsumer(int $age, ?User $owner = NULL): ConsumerInterface {
    /** @var \Drupal\consumers\Entity\ConsumerInterface $consumer */
    $consumer = $this->container->get('entity_type.manager')->getStorage('consumer')->create([
      'label' => 'Some client (unverified)',
      'client_id' => $this->randomMachineName(),
      'grant_types' => ['authorization_code'],
      'confidential' => FALSE,
      'personal' => TRUE,
      'user_id' => $owner?->id(),
      'created' => $this->now - $age,
    ]);
    $consumer->save();
    return $consumer;
  }

  /**
   * Issues an access token for the consumer, as the token endpoint would.
   */
  private function issueToken(ConsumerInterface $consumer): void {
    Oauth2Token::create([
      'bundle' => 'access_token',
      'auth_user_id' => NULL,
      'client' => $consumer->id(),
      'value' => $this->randomMachineName(32),
      'expire' => $this->now + 300,
    ])->save();
  }

  /**
   * Reloads the consumer, or NULL once it is gone.
   */
  private function reload(ConsumerInterface $consumer): ?ConsumerInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('consumer');
    $storage->resetCache();
    /** @var \Drupal\consumers\Entity\ConsumerInterface|null $reloaded */
    $reloaded = $storage->load($consumer->id());
    return $reloaded;
  }

  /**
   * The consumer's last use as it is stored.
   */
  private function lastUsed(ConsumerInterface $consumer): int {
    return (int) $this->reload($consumer)->get('last_used')->value;
  }

  /**
   * A consumer stamps its creation, and its use at most once an hour.
   */
  public function testStampsCreationAndUse(): void {
    $consumer = $this->manager->create($this->createUser(), 'Claude')->consumer;
    $this->assertSame($this->now, (int) $consumer->get('created')->value);
    $this->assertTrue($consumer->get('last_used')->isEmpty());

    $this->issueToken($consumer);
    $this->assertSame($this->now, $this->lastUsed($consumer));

    // Within the hour the stamp stands: one write per consumer per hour, not
    // one per token request.
    $this->reload($consumer)->set('last_used', $this->now - 60)->save();
    $this->issueToken($consumer);
    $this->assertSame($this->now - 60, $this->lastUsed($consumer));

    // Past the hour it moves on.
    $this->reload($consumer)->set('last_used', $this->now - 7200)->save();
    $this->issueToken($consumer);
    $this->assertSame($this->now, $this->lastUsed($consumer));
  }

  /**
   * Cron deletes unclaimed consumers past the retention, and only those.
   */
  public function testSweepsStaleUnclaimedOnly(): void {
    $stale = $this->createConsumer(self::RETENTION + 60);
    $fresh = $this->createConsumer(60);
    $owned = $this->createConsumer(self::RETENTION * 10, $this->createUser());

    $this->container->get('cron')->run();

    $this->assertNull($this->reload($stale));
    $this->assertNotNull($this->reload($fresh));
    $this->assertNotNull($this->reload($owned));
  }

  /**
   * A second sweep over the same site deletes nothing.
   */
  public function testSweepIsIdempotent(): void {
    $this->createConsumer(self::RETENTION + 60);
    $this->createConsumer(60);

    $this->assertSame(1, $this->manager->sweepUnclaimed());
    $this->assertSame(0, $this->manager->sweepUnclaimed());
  }

  /**
   * Use does not save an unclaimed consumer from the sweep.
   *
   * The sweep goes by ownership and age alone. Use cannot speak for an
   * unclaimed consumer anyway: the first token issued for a self-registered
   * client claims it for whoever authorized it (openkb_agent_registration,
   * asserted in its ClientRegistrationTest), so a used client is an owned one.
   */
  public function testUseDoesNotSaveAnUnclaimedConsumer(): void {
    $stale = $this->createConsumer(self::RETENTION + 60);
    $this->issueToken($stale);
    $this->assertSame($this->now, $this->lastUsed($stale));

    $this->assertSame(1, $this->manager->sweepUnclaimed());
    $this->assertNull($this->reload($stale));
  }

}
