<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent_registration\Kernel;

use Drupal\Core\Form\FormState;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AnonymousUserSession;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\openkb_agent\ActingIdentity;
use Drupal\openkb_agent\ConsentScreen;
use Drupal\simple_oauth\Authentication\TokenAuthUser;
use Drupal\simple_oauth\Entities\ClientEntity;
use Drupal\simple_oauth\Entities\UserEntity;
use Drupal\user\UserInterface;
use League\OAuth2\Server\Exception\OAuthServerException;
use League\OAuth2\Server\RequestTypes\AuthorizationRequest;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\Session\Session;
use Symfony\Component\HttpFoundation\Session\Storage\MockArraySessionStorage;

/**
 * Every policy decision a self-registration involves (OKB-149).
 *
 * The wire around it — the 401's `WWW-Authenticate`, the two metadata
 * documents, the pass-through — is the frontend's and is pinned by the vitest
 * suite; the one walk of the whole chain is the `mcp-connect-by-url` e2e spec.
 * What is left, and what this suite is, is the part that decides what a pasted
 * URL may turn into: who may register, what a registration is allowed to ask
 * for, what the client that comes out is, and who ends up owning it.
 */
final class ClientRegistrationTest extends KernelTestBase {

  use RecipeConfigTrait;
  use UserCreationTrait;

  private const PATH = '/openkb/agent/register';
  private const PERMISSION = 'use client registration api';

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
    'openkb_agent_registration',
  ];

  /**
   * The frontend server's account on the bridge.
   */
  private UserInterface $relay;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('file');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installConfig(['system', 'field', 'user', 'openkb_agent_registration']);
    $this->importRecipeConfig([
      'simple_oauth.oauth2_scope.agent_read',
      'simple_oauth.oauth2_scope.agent_read_content',
      'simple_oauth.oauth2_scope.agent_read_space',
      'simple_oauth.oauth2_scope.agent_write',
      'simple_oauth.oauth2_scope.agent_write_content',
      'simple_oauth.oauth2_scope.agent_write_space',
    ]);
    // User 1 is a superuser; take it out of circulation.
    $this->createUser();
    $this->relay = $this->createUser([self::PERMISSION]);
    $this->applyRegistrationSettings();
  }

  /**
   * Mirrors the config action openkb_recipe_agents applies.
   */
  private function applyRegistrationSettings(array $overrides = []): void {
    $config = $this->config('openkb_agent_registration.settings');
    foreach ($overrides + [
      'enabled' => TRUE,
      'scopes' => ['agent_read', 'agent_write'],
    ] as $key => $value) {
      $config->set($key, $value);
    }
    $config->save();
  }

  /**
   * Posts a registration, as the relay unless told otherwise.
   */
  private function postRegistration(array $metadata, ?AccountInterface $user = NULL): Response {
    $request = Request::create(self::PATH, 'POST', [], [], [], [], json_encode($metadata));
    $request->headers->set('Content-Type', 'application/json');
    $user ??= $this->relay;
    if ($user->isAuthenticated()) {
      // A session is the only carrier a route naming no provider accepts; the
      // Bearer the relay really uses resolves to the same account.
      $session = new Session(new MockArraySessionStorage());
      $session->set('uid', (int) $user->id());
      $request->setSession($session);
      $name = $this->container->get('session_configuration')->getOptions($request)['name'];
      $request->cookies->set($name, $session->getId());
    }
    // A refusal renders through an error-page subrequest, which leaves the
    // router's context on GET (core's DefaultExceptionHtmlSubscriber) — the
    // next POST in this process would otherwise be answered 405.
    $this->container->get('router.no_access_checks')->getContext()->setMethod('POST');
    $response = $this->container->get('http_kernel')->handle($request);
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
    return $response;
  }

  /**
   * The decoded body of a response.
   */
  private function decode(Response $response): array {
    $decoded = json_decode((string) $response->getContent(), TRUE);
    return is_array($decoded) ? $decoded : [];
  }

  /**
   * A minimal well-formed registration.
   */
  private static function metadata(array $overrides = []): array {
    return $overrides + [
      'client_name' => 'Claude',
      'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback'],
      'grant_types' => ['authorization_code', 'refresh_token'],
      'response_types' => ['code'],
      'token_endpoint_auth_method' => 'none',
    ];
  }

  /**
   * Acting identity as the container builds it.
   */
  private function actingIdentity(): ActingIdentity {
    return $this->container->get('openkb_agent.acting_identity');
  }

  /**
   * The one self-registered consumer, loaded fresh.
   */
  private function registeredConsumer(string $client_id): ConsumerInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('consumer');
    $ids = $storage->getQuery()->accessCheck(FALSE)->condition('client_id', $client_id)->execute();
    $this->assertCount(1, $ids, 'exactly one consumer for the issued client_id');
    $storage->resetCache($ids);
    /** @var \Drupal\consumers\Entity\ConsumerInterface $consumer */
    $consumer = $storage->load(reset($ids));
    return $consumer;
  }

  /**
   * Registers a client and returns the consumer it created.
   */
  private function registerClient(array $overrides = []): ConsumerInterface {
    $response = $this->postRegistration(self::metadata($overrides));
    $this->assertSame(201, $response->getStatusCode());
    return $this->registeredConsumer($this->decode($response)['client_id']);
  }

  /**
   * An access token issued to a consumer for a user, as `/oauth/token` does.
   */
  private function issueToken(ConsumerInterface $consumer, UserInterface $user): void {
    $token = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->create([
      'bundle' => 'access_token',
      'client' => $consumer->id(),
      'auth_user_id' => $user->id(),
      'value' => 'token-' . $consumer->id() . '-' . $user->id(),
      'scopes' => [['scope_id' => 'agent_read']],
      'expire' => \Drupal::time()->getRequestTime() + 300,
    ]);
    $token->save();
    $this->container->get('current_user')->setAccount(new TokenAuthUser(
      $this->container->get('permission_checker'),
      $token,
      $this->container->get('psr7.http_message_factory'),
      $this->container->get('request_stack'),
    ));
  }

  /**
   * Nobody without the relay's permission gets in — no matter who they are.
   *
   * Registration is anonymous by protocol, so the account this refuses is
   * never the registrant's: it is whoever reached the bridge instead of the
   * collaboration server.
   */
  public function testRefusesWithoutTheRelayPermission(): void {
    $callers = [
      'anonymous' => new AnonymousUserSession(),
      'authenticated' => $this->createUser(),
      // The account that administers OAuth clients by hand still cannot
      // register one this way — this bridge is the relay's, not an admin tool.
      'administer simple_oauth entities' => $this->createUser(['administer simple_oauth entities']),
    ];
    foreach ($callers as $label => $caller) {
      $response = $this->postRegistration(self::metadata(), $caller);
      $this->assertSame(403, $response->getStatusCode(), "$label is refused");
    }
    $this->assertCount(0, $this->container->get('entity_type.manager')->getStorage('consumer')->loadMultiple());
  }

  /**
   * The happy path: a public, PKCE-only client and a valid RFC 7591 response.
   */
  public function testRegistersPublicPkceClient(): void {
    $response = $this->postRegistration(self::metadata());
    $this->assertSame(201, $response->getStatusCode());
    $body = $this->decode($response);

    $this->assertNotEmpty($body['client_id']);
    $this->assertArrayNotHasKey('client_secret', $body, 'a public client is issued no secret');
    $this->assertSame('none', $body['token_endpoint_auth_method']);
    $this->assertSame('Claude' . ActingIdentity::UNVERIFIED_SUFFIX, $body['client_name'], 'the name as registered');
    $this->assertSame(['https://claude.ai/api/mcp/auth_callback'], $body['redirect_uris']);
    $this->assertSame(['authorization_code', 'refresh_token'], $body['grant_types']);
    $this->assertSame(['code'], $body['response_types']);
    $this->assertIsInt($body['client_id_issued_at']);

    $consumer = $this->registeredConsumer($body['client_id']);
    $this->assertFalse((bool) $consumer->get('confidential')->value, 'public client');
    $this->assertTrue((bool) $consumer->get('pkce')->value, 'PKCE required');
    $this->assertFalse((bool) $consumer->get('automatic_authorization')->value, 'a human sees the consent screen');
    $this->assertTrue($consumer->get('secret')->isEmpty(), 'no secret stored');
    $this->assertSame(
      ['authorization_code', 'refresh_token'],
      array_column($consumer->get('grant_types')->getValue(), 'value'),
    );
    $this->assertSame(
      ['https://claude.ai/api/mcp/auth_callback'],
      array_column($consumer->get('redirect')->getValue(), 'value'),
    );

    // Owner-bound and self-service like a client provisioned on a profile, and
    // nobody's until the first person consents to it.
    $this->assertTrue((bool) $consumer->get('personal')->value, 'a personal consumer');
    $this->assertTrue($consumer->get('user_id')->isEmpty(), 'owned by nobody yet');
  }

  /**
   * A registration asking beyond the ceiling is refused, never narrowed.
   */
  public function testRefusesScopesBeyondTheCeiling(): void {
    $shipped = $this->decode($this->postRegistration(self::metadata(['scope' => 'agent:read agent:write'])));
    $this->assertSame('agent:read agent:write', $shipped['scope'], 'the shipped ceiling grants both');

    // The ceiling is config, and everything below is the same request against
    // a site that narrowed it.
    $this->applyRegistrationSettings(['scopes' => ['agent_read']]);

    $over = $this->postRegistration(self::metadata(['scope' => 'agent:read agent:write']));
    $this->assertSame(400, $over->getStatusCode(), 'asking for more is refused, not trimmed');
    $this->assertSame('invalid_client_metadata', $this->decode($over)['error']);
    $this->assertStringContainsString('agent:write', $this->decode($over)['error_description'], 'named what it may not have');
    $this->assertStringContainsString('agent:read', $this->decode($over)['error_description'], 'and what the site does grant');

    $within = $this->decode($this->postRegistration(self::metadata(['scope' => 'agent:read'])));
    $this->assertSame('agent:read', $within['scope'], 'asking within the ceiling is granted as asked');
    $this->assertSame(
      ['agent_read'],
      array_column($this->registeredConsumer($within['client_id'])->get('authorization_code_scopes')->getValue(), 'scope_id'),
    );

    // Naming nothing is not asking for more: the client is saying "whatever
    // you allow", and gets the ceiling.
    $silent = $this->decode($this->postRegistration(self::metadata()));
    $this->assertSame('agent:read', $silent['scope'], 'asking for nothing is granted the ceiling');

    // A scope the site does not know at all is refused the same way.
    $unknown = $this->postRegistration(self::metadata(['scope' => 'agent:read admin:everything']));
    $this->assertSame(400, $unknown->getStatusCode());
    $this->assertSame('invalid_client_metadata', $this->decode($unknown)['error']);

    // And a site offering nothing registers nothing, rather than a client that
    // can do nothing.
    $this->applyRegistrationSettings(['scopes' => []]);
    $none = $this->postRegistration(self::metadata());
    $this->assertSame(403, $none->getStatusCode());
    $this->assertSame('invalid_client_metadata', $this->decode($none)['error']);
  }

  /**
   * What a registration may ask for is stated publicly, from config.
   *
   * The frontend reads this to fill `scopes_supported` in both metadata
   * documents, so a client asks for scopes it can actually have.
   */
  public function testStatesWhatMayBeAskedFor(): void {
    $request = Request::create('/openkb/agent/registration/metadata');
    $response = $this->container->get('http_kernel')->handle($request);
    $this->assertSame(200, $response->getStatusCode());
    $this->assertSame(
      ['scopes_supported' => ['agent:read', 'agent:write']],
      $this->decode($response),
      'by wire name, which is what a client asks with',
    );

    $this->applyRegistrationSettings(['scopes' => ['agent_read']]);
    $narrowed = $this->container->get('http_kernel')->handle(Request::create('/openkb/agent/registration/metadata'));
    $this->assertSame(['scopes_supported' => ['agent:read']], $this->decode($narrowed), 'follows the config');
  }

  /**
   * A self-registered client's label says its name is self-asserted.
   */
  public function testMarksTheClientUnverifiedInItsLabel(): void {
    $consumer = $this->registerClient();
    $this->assertSame('Claude' . ActingIdentity::UNVERIFIED_SUFFIX, $consumer->label());

    // Attribution reads the label, so the marking reaches every surface that
    // shows one without any of them knowing the distinction exists.
    $owner = $this->createUser();
    $this->issueToken($consumer, $owner);
    $identity = $this->actingIdentity();
    $this->assertSame('Claude' . ActingIdentity::UNVERIFIED_SUFFIX, $identity->via());
    $this->assertTrue($identity->isAgent());
    $this->assertSame((int) $owner->id(), $identity->uid(), 'the token still acts as its human');
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
  }

  /**
   * The first person to authorize a registered client becomes its owner.
   *
   * Nobody owns it at registration — it is anonymous by protocol. From the
   * first token on it is that person's, so it lists and revokes on their
   * profile like a client they provisioned by hand.
   */
  public function testFirstConsentClaimsTheClient(): void {
    $consumer = $this->registerClient();
    $editor = $this->createUser();
    $this->issueToken($consumer, $editor);
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());

    $claimed = $this->registeredConsumer($consumer->getClientId());
    $this->assertSame((int) $editor->id(), (int) $claimed->get('user_id')->target_id);

    /** @var \Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface $manager */
    $manager = $this->container->get('simple_oauth_personal_consumers.manager');
    $this->assertSame(
      [(int) $claimed->id()],
      array_map('intval', array_keys($manager->getConsumers($editor))),
      'it lists under the profile Agent tokens tab, revocable there',
    );

    // A second person authorizing the same client does not take it over: the
    // token still acts as them, the client stays where it was claimed.
    $other = $this->createUser();
    $this->issueToken($claimed, $other);
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
    $this->assertSame(
      (int) $editor->id(),
      (int) $this->registeredConsumer($consumer->getClientId())->get('user_id')->target_id,
    );
    $this->assertSame([], $manager->getConsumers($other));
  }

  /**
   * The authorization code that triggers the claim survives it.
   *
   * Saving a consumer makes simple_oauth revoke every non-refresh token it
   * has, and an authorization code is one — so a claim that runs once the code
   * exists deletes the very code the client is about to exchange, and every
   * first authorization dies at the token endpoint with `invalid_grant`.
   */
  public function testClaimDoesNotRevokeTheCodeThatTriggeredIt(): void {
    $consumer = $this->registerClient();
    $editor = $this->createUser();

    $code = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->create([
      'bundle' => 'auth_code',
      'client' => $consumer->id(),
      'auth_user_id' => $editor->id(),
      'value' => 'code-' . $consumer->id(),
      'scopes' => [['scope_id' => 'agent_read']],
      'expire' => \Drupal::time()->getRequestTime() + 300,
    ]);
    $code->save();

    $this->assertSame(
      (int) $editor->id(),
      (int) $this->registeredConsumer($consumer->getClientId())->get('user_id')->target_id,
      'the code claimed the client',
    );
    $storage = $this->container->get('entity_type.manager')->getStorage('oauth2_token');
    $storage->resetCache();
    $this->assertNotNull($storage->load($code->id()), 'the code is still exchangeable');
  }

  /**
   * A provisioned personal consumer keeps its plain label and its owner.
   */
  public function testProvisionedClientIsNotMarkedOrReclaimed(): void {
    $owner = $this->createUser();
    /** @var \Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface $manager */
    $manager = $this->container->get('simple_oauth_personal_consumers.manager');
    $consumer = $manager->create($owner, 'Claude')->consumer;

    $this->issueToken($consumer, $this->createUser());
    $identity = $this->actingIdentity();
    $this->assertSame('Claude', $identity->via(), 'nothing self-asserted, nothing marked');
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());

    $storage = $this->container->get('entity_type.manager')->getStorage('consumer');
    $storage->resetCache([$consumer->id()]);
    $this->assertSame(
      (int) $owner->id(),
      (int) $storage->load($consumer->id())->get('user_id')->target_id,
      'a client that already has an owner is never re-owned',
    );
  }

  /**
   * Redirect URIs: https, or http on a loopback address, and nothing else.
   */
  public function testValidatesRedirectUris(): void {
    $accepted = [
      'https' => 'https://claude.ai/api/mcp/auth_callback',
      'loopback v4' => 'http://127.0.0.1:49731/callback',
      'loopback v6' => 'http://[::1]:49731/callback',
      // What Claude Code registers, on the port it bound this run: it comes
      // back on that same one, so exact matching is all it needs.
      'loopback by name' => 'http://localhost:49731/callback',
    ];
    foreach ($accepted as $label => $uri) {
      $response = $this->postRegistration(self::metadata(['redirect_uris' => [$uri]]));
      $this->assertSame(201, $response->getStatusCode(), "$label is accepted");
      $this->assertSame([$uri], $this->decode($response)['redirect_uris']);
    }

    $refused = [
      'plain http' => 'http://example.com/callback',
      'a non-http scheme' => 'ftp://example.com/callback',
      'a fragment' => 'https://example.com/callback#token',
      'not a URI' => 'not-a-uri',
      'no host' => 'https:///callback',
    ];
    foreach ($refused as $label => $uri) {
      $response = $this->postRegistration(self::metadata(['redirect_uris' => [$uri]]));
      $this->assertSame(400, $response->getStatusCode(), "$label is refused");
      $this->assertSame('invalid_redirect_uri', $this->decode($response)['error'], "$label is refused as such");
    }

    foreach ([[], 'https://claude.ai/cb', [42]] as $index => $uris) {
      $response = $this->postRegistration(['client_name' => 'Claude', 'redirect_uris' => $uris]);
      $this->assertSame(400, $response->getStatusCode(), "unusable redirect_uris #$index");
    }

    // One bad URI in a list poisons the whole registration — a client with a
    // redirect nobody validated is what the rule exists to prevent.
    $mixed = $this->postRegistration(self::metadata([
      'redirect_uris' => ['https://claude.ai/cb', 'http://example.com/cb'],
    ]));
    $this->assertSame(400, $mixed->getStatusCode());
  }

  /**
   * A nameless or unreadable registration is refused.
   */
  public function testRefusesUnusableMetadata(): void {
    foreach ([[], ['client_name' => '  '], ['client_name' => 42]] as $index => $overrides) {
      $metadata = self::metadata($overrides);
      unset($metadata['client_name']);
      $response = $this->postRegistration($overrides + ['redirect_uris' => ['https://claude.ai/cb']]);
      $this->assertSame(400, $response->getStatusCode(), "nameless registration #$index");
      $this->assertSame('invalid_client_metadata', $this->decode($response)['error']);
    }

    // A self-asserted name cannot crowd out the marking the label carries.
    $long = $this->decode($this->postRegistration(self::metadata(['client_name' => str_repeat('a', 400)])));
    $this->assertSame(100 + mb_strlen(ActingIdentity::UNVERIFIED_SUFFIX), mb_strlen($long['client_name']));
  }

  /**
   * A client is refused what it may not have, at token time too.
   *
   * A consumer's `authorization_code_scopes` is only a default in simple_oauth
   * and is intersected against for the client-credentials grant alone. Without
   * the decorator a registered client could ask for the full set on
   * `/oauth/authorize` one request after registering within the ceiling, and
   * get it.
   */
  public function testRefusesScopesBeyondTheConsumerAtTokenTime(): void {
    $this->applyRegistrationSettings(['scopes' => ['agent_read']]);
    $registered = $this->registerClient();

    /** @var \League\OAuth2\Server\Repositories\ScopeRepositoryInterface $repository */
    $repository = $this->container->get('simple_oauth.repositories.scope');
    $read = [$repository->getScopeEntityByIdentifier('agent:read')];
    $both = array_map(
      fn (string $name) => $repository->getScopeEntityByIdentifier($name),
      ['agent:read', 'agent:write'],
    );
    $owner = $this->createUser();

    $granted = $repository->finalizeScopes($read, 'authorization_code', new ClientEntity($registered), (string) $owner->id());
    $this->assertSame(
      ['agent:read'],
      array_map(static fn ($scope) => $scope->getIdentifier(), $granted),
      'what it registered with is granted',
    );

    try {
      $repository->finalizeScopes($both, 'authorization_code', new ClientEntity($registered), (string) $owner->id());
      $this->fail('asking beyond the registered scopes is refused');
    }
    catch (OAuthServerException $e) {
      $this->assertSame(5, $e->getCode(), 'invalid_scope');
      $this->assertStringContainsString('agent:write', $e->getHint() ?? '');
    }

    // The cap is the consumer's own scope field, so a client an administrator
    // provisioned with scopes is held to them too.
    $provisioned = $this->container->get('entity_type.manager')->getStorage('consumer')->create([
      'label' => 'Provisioned',
      'client_id' => 'provisioned-by-hand',
      'grant_types' => ['authorization_code'],
      'confidential' => TRUE,
      'authorization_code_scopes' => ['agent_read'],
    ]);
    $provisioned->save();
    $this->expectException(OAuthServerException::class);
    $repository->finalizeScopes($both, 'authorization_code', new ClientEntity($provisioned), (string) $owner->id());
  }

  /**
   * A client with no scopes of its own is capped by nothing here.
   */
  public function testConsumerWithoutScopesIsLeftToSimpleOauth(): void {
    $unscoped = $this->container->get('entity_type.manager')->getStorage('consumer')->create([
      'label' => 'Unscoped',
      'client_id' => 'unscoped-by-hand',
      'grant_types' => ['authorization_code'],
      'confidential' => TRUE,
    ]);
    $unscoped->save();

    /** @var \League\OAuth2\Server\Repositories\ScopeRepositoryInterface $repository */
    $repository = $this->container->get('simple_oauth.repositories.scope');
    $both = array_map(
      fn (string $name) => $repository->getScopeEntityByIdentifier($name),
      ['agent:read', 'agent:write'],
    );
    $finalized = $repository->finalizeScopes($both, 'authorization_code', new ClientEntity($unscoped), (string) $this->createUser()->id());
    $this->assertSame(
      ['agent:read', 'agent:write'],
      array_map(static fn ($scope) => $scope->getIdentifier(), $finalized),
    );
  }

  /**
   * The marking is registration's word; the name is the person's.
   *
   * Registration is what marks a self-asserted name, so it is here that what
   * the one surface a person reads before approving does with it is pinned:
   * the screen asks about the name alone, and approving is a human standing
   * behind the name they leave in the field. Attribution then reads that name,
   * with nothing left to mark.
   *
   * @see \Drupal\Tests\openkb_agent\Kernel\ConsentScreenTest
   */
  public function testTheConsentScreenIsWhereTheNameIsConfirmed(): void {
    $registered = $this->registeredConsumer(
      $this->decode($this->postRegistration(self::metadata(['scope' => 'agent:read'])))['client_id'],
    );
    $this->assertSame('Claude' . ActingIdentity::UNVERIFIED_SUFFIX, $registered->label());

    /** @var \League\OAuth2\Server\Repositories\ScopeRepositoryInterface $repository */
    $repository = $this->container->get('simple_oauth.repositories.scope');
    $auth_request = new AuthorizationRequest();
    $auth_request->setClient(new ClientEntity($registered));
    $auth_request->setScopes([$repository->getScopeEntityByIdentifier('agent:read')]);
    $auth_request->setRedirectUri('https://claude.ai/api/mcp/auth_callback');
    $approver = new UserEntity();
    $approver->setIdentifier($this->createUser()->id());
    $auth_request->setUser($approver);

    $form = ['actions' => ['submit' => ['#authorized' => TRUE], 'cancel' => []]];
    $form_state = new FormState();
    $form_state->set('auth_request', $auth_request);
    $screen = $this->container->get('openkb_agent.consent_screen');
    $screen->alterForm($form, $form_state);
    $props = $screen->props($form);

    $this->assertSame('Claude', $props['client'], 'the marking is the site\'s word about the name, not part of it');
    // The heading names the client as registered; the field offers a handle.
    $this->assertSame('claude', $form[ConsentScreen::NAME_ELEMENT]['#default_value']);
    $this->assertSame(['agent:read'], array_column($props['scopes'], 'name'));

    // Allow, under the name the person chose instead.
    $form_state->setTriggeringElement($form['actions']['submit']);
    $form_state->setValue(ConsentScreen::NAME_ELEMENT, 'Rex');
    $screen->renameAgent($form, $form_state);

    $owner = $this->createUser();
    $this->issueToken($this->registeredConsumer($registered->getClientId()), $owner);
    $this->assertSame('Rex', $this->actingIdentity()->via(), 'attribution reads the confirmed name');
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
  }

  /**
   * Registration can be turned off entirely, and then nothing is created.
   */
  public function testCanBeDisabled(): void {
    $this->applyRegistrationSettings(['enabled' => FALSE]);
    $response = $this->postRegistration(self::metadata());
    $this->assertSame(403, $response->getStatusCode());
    $this->assertCount(0, $this->container->get('entity_type.manager')->getStorage('consumer')->loadMultiple());
  }

}
