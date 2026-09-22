<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\Core\Cache\CacheableJsonResponse;
use Drupal\Core\Session\AccountInterface;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\openkb_agent\Controller\MyAgentsController;

/**
 * What `/openkb/me/agents` answers, and what may be cached about it (OKB-277).
 *
 * The picker hands a thread to an agent that is not in the session, so it needs
 * the labels the caller's own clients hold. The answer is one account's, so its
 * cacheability is part of the answer: the `user` context is what keeps one
 * person's clients out of another's response, and the consumer tags are what
 * make a client registered, renamed or revoked show up.
 */
final class MyAgentsControllerTest extends KernelTestBase {

  use UserCreationTrait;

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
    'simple_oauth_personal_consumers',
    'openkb_agent',
  ];

  /**
   * Client ids are unique per consumer.
   */
  private int $clients = 0;

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
    // The first saved account is the superuser (KernelTestBase installs no
    // user module hooks), and an admin owner is refused an agent anyway.
    $this->createUser();
  }

  /**
   * A named, unrevoked client of the caller's is answered; the others are not.
   */
  public function testAnswersTheCallersOwnNamedClients(): void {
    $owner = $this->createUser();
    $somebody_else = $this->createUser();

    $this->consumer('claude', $owner);
    $this->consumer('  ', $owner);
    $this->consumer('codex', $owner)->set('status', FALSE)->save();
    $this->consumer('theirs', $somebody_else);

    $this->assertSame([['label' => 'claude']], $this->agents($owner)['agents']);
    $this->assertSame([['label' => 'theirs']], $this->agents($somebody_else)['agents']);
  }

  /**
   * The answer varies per account and follows the clients it listed.
   */
  public function testIsCacheablePerAccountAndPerClient(): void {
    $owner = $this->createUser();
    $consumer = $this->consumer('claude', $owner);

    $response = $this->respond($owner);
    $cacheability = $response->getCacheableMetadata();

    $this->assertContains('user', $cacheability->getCacheContexts());
    $this->assertContains('consumer_list', $cacheability->getCacheTags());
    $this->assertContains('consumer:' . $consumer->id(), $cacheability->getCacheTags());
    $this->assertFalse($response->headers->hasCacheControlDirective('no-store'));
  }

  /**
   * The response the controller answers `$account` with.
   */
  private function respond(AccountInterface $account): CacheableJsonResponse {
    $this->container->get('current_user')->setAccount($account);
    return MyAgentsController::create($this->container)->agents();
  }

  /**
   * The decoded answer.
   */
  private function agents(AccountInterface $account): array {
    return json_decode((string) $this->respond($account)->getContent(), TRUE);
  }

  /**
   * One personal client of `$owner`'s, labelled `$label`.
   */
  private function consumer(string $label, AccountInterface $owner): ConsumerInterface {
    /** @var \Drupal\consumers\Entity\ConsumerInterface $consumer */
    $consumer = $this->container->get('entity_type.manager')->getStorage('consumer')->create([
      'label' => $label,
      'client_id' => 'client-' . ++$this->clients,
      'grant_types' => ['client_credentials'],
      'personal' => TRUE,
      'user_id' => $owner->id(),
    ]);
    $consumer->save();
    return $consumer;
  }

}
