<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\Core\Session\AnonymousUserSession;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\simple_oauth\Authentication\TokenAuthUser;
use Symfony\Component\HttpFoundation\Request;

/**
 * Agent identity stands on its own, without self-registration (OKB-149).
 *
 * Connecting by URL is one way to get an agent token and provisioning a
 * personal consumer by hand is the other, so the site that wants only the
 * second one leaves `openkb_agent_registration` uninstalled. What that has to
 * mean: the bridge is not reachable, no client can be self-registered, and
 * nothing about provisioned tokens changes.
 */
final class AgentWithoutRegistrationTest extends KernelTestBase {

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
  }

  /**
   * The registration bridge does not exist, and nothing claims a client.
   */
  public function testTheBridgeIsNotThere(): void {
    foreach (['/openkb/agent/register' => 'POST', '/openkb/agent/registration/metadata' => 'GET'] as $path => $method) {
      $request = Request::create($path, $method, [], [], [], [], '{}');
      $request->headers->set('Content-Type', 'application/json');
      $this->assertSame(404, $this->container->get('http_kernel')->handle($request)->getStatusCode(), $path);
    }

    // Claiming an unowned personal consumer on first consent is the
    // submodule's; without it such a client stays nobody's.
    $storage = $this->container->get('entity_type.manager')->getStorage('consumer');
    $consumer = $storage->create([
      'label' => 'Unowned',
      'client_id' => 'unowned-by-hand',
      'personal' => TRUE,
    ]);
    $consumer->save();
    $token = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->create([
      'bundle' => 'access_token',
      'client' => $consumer->id(),
      'auth_user_id' => $this->createUser()->id(),
      'value' => 'irrelevant-to-ownership',
      'expire' => \Drupal::time()->getRequestTime() + 300,
    ]);
    $token->save();
    $storage->resetCache([$consumer->id()]);
    $this->assertTrue($storage->load($consumer->id())->get('user_id')->isEmpty());
  }

  /**
   * A provisioned agent token is attributed exactly as before.
   */
  public function testProvisionedTokensStillAttribute(): void {
    $owner = $this->createUser();
    /** @var \Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface $manager */
    $manager = $this->container->get('simple_oauth_personal_consumers.manager');
    $consumer = $manager->create($owner, 'Claude')->consumer;

    $token = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->create([
      'bundle' => 'access_token',
      'client' => $consumer->id(),
      'auth_user_id' => $owner->id(),
      // The ceiling the provisioning caps such a token at, and what makes the
      // request an agent's ({@see \Drupal\openkb_agent\ActingIdentity}).
      'scopes' => [['scope_id' => 'agent_read'], ['scope_id' => 'agent_write']],
      'value' => 'irrelevant-to-attribution',
      'expire' => \Drupal::time()->getRequestTime() + 300,
    ]);
    $token->save();
    $this->container->get('current_user')->setAccount(new TokenAuthUser(
      $this->container->get('permission_checker'),
      $token,
      $this->container->get('psr7.http_message_factory'),
      $this->container->get('request_stack'),
    ));

    /** @var \Drupal\openkb_agent\ActingIdentity $identity */
    $identity = $this->container->get('openkb_agent.acting_identity');
    $this->assertSame('Claude', $identity->via());
    $this->assertTrue($identity->isAgent());
    $this->assertSame((int) $owner->id(), $identity->uid());
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
  }

}
