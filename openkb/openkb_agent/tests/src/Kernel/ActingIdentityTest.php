<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\Core\Session\AnonymousUserSession;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\openkb_agent\ActingIdentity;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\consumers\Entity\Consumer;
use Drupal\simple_oauth\Authentication\TokenAuthUser;
use Drupal\user\UserInterface;

/**
 * What makes a request an agent's: an agent scope on its token (ADR 0015).
 *
 * The client it was issued on decides nothing. A person's own client and the
 * chat's system-wide one both answer `via` with their label, and a token
 * without an agent scope — the collaboration server's — is a direct request.
 *
 * @group openkb_agent
 */
final class ActingIdentityTest extends KernelTestBase {

  use RecipeConfigTrait;
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
   * The account every client here acts for.
   */
  private UserInterface $owner;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('file');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installConfig(['system', 'field', 'user', 'simple_oauth']);
    $this->importRecipeConfig([
      'simple_oauth.oauth2_scope.agent_read',
      'simple_oauth.oauth2_scope.agent_write',
    ]);
    // User 1 is a superuser; take it out of circulation.
    $this->createUser();
    $this->owner = $this->createUser();
  }

  /**
   * {@inheritdoc}
   */
  protected function tearDown(): void {
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
    parent::tearDown();
  }

  /**
   * The chat's client is nobody's own, and its writes still read as an agent's.
   */
  public function testTheChatsSystemWideClientIsAnAgent(): void {
    $identity = $this->identityOn($this->client('OpenKB AI', FALSE), ['agent_read', 'agent_write']);

    $this->assertSame('OpenKB AI', $identity->via());
    $this->assertTrue($identity->isAgent());
    $this->assertSame((int) $this->owner->id(), $identity->uid());
  }

  /**
   * A person's own client answers the same way, off the same scope.
   */
  public function testAnOwnedPersonalClientIsAnAgent(): void {
    $identity = $this->identityOn($this->client('Claude', TRUE), ['agent_read', 'agent_write']);

    $this->assertSame('Claude', $identity->via());
    $this->assertTrue($identity->isAgent());
  }

  /**
   * A token without an agent scope is a direct request, whoever issued it.
   */
  public function testTheTokenWithoutAnAgentScopeIsDirect(): void {
    $identity = $this->identityOn($this->client('Collaboration server', FALSE), []);

    $this->assertNull($identity->via());
    $this->assertFalse($identity->isAgent());
  }

  /**
   * One client, personal or not.
   */
  private function client(string $label, bool $personal): Consumer {
    $consumer = Consumer::create([
      'label' => $label,
      'client_id' => strtolower(str_replace(' ', '_', $label)),
      'personal' => $personal,
      'grant_types' => ['client_credentials'],
    ]);
    $consumer->save();

    return $consumer;
  }

  /**
   * The identity of a request arriving on a token of `$client`.
   *
   * @param \Drupal\consumers\Entity\Consumer $client
   *   The client the token was issued on.
   * @param string[] $scopes
   *   The scope ids the token carries.
   *
   * @return \Drupal\openkb_agent\ActingIdentity
   *   The acting identity, reading the current user.
   */
  private function identityOn(Consumer $client, array $scopes): ActingIdentity {
    $token = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->create([
      'bundle' => 'access_token',
      'client' => $client->id(),
      'auth_user_id' => $this->owner->id(),
      'scopes' => array_map(static fn (string $id): array => ['scope_id' => $id], $scopes),
      'value' => 'token-' . $client->id(),
      'expire' => $this->container->get('datetime.time')->getRequestTime() + 300,
    ]);
    $token->save();
    $this->container->get('current_user')->setAccount(new TokenAuthUser(
      $this->container->get('permission_checker'),
      $token,
      $this->container->get('psr7.http_message_factory'),
      $this->container->get('request_stack'),
    ));

    return $this->container->get('openkb_agent.acting_identity');
  }

}
