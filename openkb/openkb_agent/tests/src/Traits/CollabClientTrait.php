<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Traits;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AnonymousUserSession;
use Drupal\Tests\simple_oauth\Functional\SimpleOauthTestTrait;
use Drupal\consumers\Entity\Consumer;
use Drupal\simple_oauth\Authentication\TokenAuthUser;
use Drupal\simple_oauth\Authentication\TokenAuthUserInterface;
use Drupal\user\UserInterface;
use GuzzleHttp\RequestOptions;
use Symfony\Component\HttpFoundation\Request;

/**
 * The collaboration server's own connection, as a request arrives on it.
 *
 * A checkpoint is believed because of the connection it is made on: an OAuth
 * token carrying the client's `collab` scope, which only a consumer registered
 * for it can obtain ({@see \Drupal\openkb_workflow\CollabServerIdentity}). So a
 * suite about what a checkpoint buys has to make one — the account alone,
 * whatever permissions it holds, is deliberately not enough.
 *
 * Two ways in, for the two kinds of suite. {@see self::onOauthConnection()}
 * builds the account simple_oauth's authentication would hand a request, for a
 * suite that saves an entity and looks at what came out.
 * {@see self::collabBearer()} issues a real token through `/oauth/token`, for a
 * suite that asks a route; {@see self::agentBearer()} issues an agent's one
 * through the same exchange, for a suite that asks it on both carriers.
 */
trait CollabClientTrait {

  use RecipeConfigTrait;
  use SimpleOauthTestTrait;

  /**
   * The scope that makes a connection the collaboration client's.
   */
  protected const COLLAB_SCOPE = 'collab';

  /**
   * Config the collaboration client's identity is made of.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function collabClientConfigNames(): array {
    return [
      'user.role.collab_server',
      'simple_oauth.oauth2_scope.collab',
    ];
  }

  /**
   * The account `$user` is, reaching Drupal on a connection granted `$scope`.
   *
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the client acts as.
   * @param string $scope
   *   The scope id the token carries; defaults to the collaboration client's.
   *
   * @return \Drupal\simple_oauth\Authentication\TokenAuthUserInterface
   *   The account a request on that connection authenticates as.
   */
  protected function onOauthConnection(AccountInterface $user, string $scope = self::COLLAB_SCOPE): TokenAuthUserInterface {
    $consumer = $this->oauthClient($user, $scope);
    $token = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->create([
      'bundle' => 'access_token',
      'client' => $consumer->id(),
      'auth_user_id' => $user->id(),
      'scopes' => [['scope_id' => $scope]],
      'value' => "$scope-token-" . $user->id(),
      'expire' => $this->container->get('datetime.time')->getRequestTime() + 300,
    ]);
    $token->save();

    return new TokenAuthUser(
      $this->container->get('permission_checker'),
      $token,
      $this->container->get('psr7.http_message_factory'),
      $this->container->get('request_stack'),
    );
  }

  /**
   * The carrier of a request the client actually made, from `/oauth/token`.
   *
   * Needs {@see self::installOauthKeys()} to have run.
   *
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The service account the client acts as.
   * @param string $scope
   *   The scope id to ask for; defaults to the collaboration client's.
   *
   * @return array
   *   The `Authorization` header, ready for a request.
   */
  protected function collabBearer(AccountInterface $user, string $scope = self::COLLAB_SCOPE): array {
    $secret = 'secret-' . $user->id();
    $consumer = $this->oauthClient($user, $scope);
    $consumer->set('secret', $secret)->save();

    return $this->issuedBearer((string) $consumer->getClientId(), $secret, $scope);
  }

  /**
   * The carrier of a request an agent made, from the same exchange.
   *
   * The owner's personal consumer, which is what the agent registers for the
   * account: its token authenticates as the owner, capped at the agent scopes.
   * Needs {@see self::installOauthKeys()} to have run.
   *
   * @param \Drupal\user\UserInterface $owner
   *   The account the agent acts as.
   *
   * @return array
   *   The `Authorization` header, ready for a request.
   */
  protected function agentBearer(UserInterface $owner): array {
    $credentials = $this->container->get('simple_oauth_personal_consumers.manager')
      ->create($owner, 'Claude');

    return $this->issuedBearer($credentials->clientId, $credentials->secret);
  }

  /**
   * Exchanges client credentials for a token, the way a client obtains one.
   *
   * Issued rather than assembled: what the exchange grants is the exchange's
   * answer, and it is half of what these suites assert.
   *
   * @param string $client_id
   *   The client id to present.
   * @param string $secret
   *   The client secret to present.
   * @param string|null $scope
   *   The scope id to ask for, or NULL for the client's own.
   *
   * @return array
   *   The `Authorization` header, ready for a request.
   */
  private function issuedBearer(string $client_id, string $secret, ?string $scope = NULL): array {
    $response = $this->container->get('http_kernel')->handle(Request::create('/oauth/token', 'POST', array_filter([
      'grant_type' => 'client_credentials',
      'client_id' => $client_id,
      'client_secret' => $secret,
      'scope' => $scope,
    ])));
    $granted = Json::decode((string) $response->getContent());
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    // The exchange leaves its own account behind; a suite reading storage next
    // must not do so as whoever the last request authenticated as.
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());

    return ['Authorization' => 'Bearer ' . $granted['access_token']];
  }

  /**
   * The same carrier, exchanged over HTTP against a served site.
   *
   * What a browser suite needs: the token has to be issued by the site the
   * request will reach, not by the test process' own kernel. Needs
   * `setUpKeys()` to have run.
   *
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The service account the client acts as.
   * @param string $scope
   *   The scope id to ask for; defaults to the collaboration client's.
   *
   * @return array
   *   The `Authorization` header, ready for a request.
   */
  protected function collabBearerOverHttp(AccountInterface $user, string $scope = self::COLLAB_SCOPE): array {
    $secret = 'secret-' . $user->id();
    $consumer = $this->oauthClient($user, $scope);
    $consumer->set('secret', $secret)->save();

    $response = $this->getHttpClient()->post($this->buildUrl('/oauth/token'), [
      RequestOptions::FORM_PARAMS => [
        'grant_type' => 'client_credentials',
        'client_id' => (string) $consumer->getClientId(),
        'client_secret' => $secret,
        'scope' => $scope,
      ],
    ]);
    $granted = Json::decode((string) $response->getBody());
    $this->assertNotEmpty($granted['access_token'] ?? '', (string) $response->getBody());

    return ['Authorization' => 'Bearer ' . $granted['access_token']];
  }

  /**
   * Gives the site a signing keypair, so `/oauth/token` can answer at all.
   *
   * On disk under the test's own site directory. A kernel test has no private
   * file system for `setUpKeys()` to write to, which is what a browser suite
   * uses instead.
   */
  protected function installOauthKeys(): void {
    $keys = $this->siteDirectory . '/keys';
    mkdir($keys, 0775, TRUE);
    file_put_contents("$keys/public.key", $this->publicKey);
    file_put_contents("$keys/private.key", $this->privateKey);
    chmod("$keys/public.key", 0660);
    chmod("$keys/private.key", 0660);
    $this->config('simple_oauth.settings')
      ->set('public_key', "$keys/public.key")
      ->set('private_key', "$keys/private.key")
      ->save();
  }

  /**
   * The consumer `$user` acts as, registered for `$scope` and nothing else.
   *
   * The account joins the scope's own role, as the provisioning puts it there:
   * simple_oauth caps a token at the intersection of its scopes' roles and its
   * account's, so a token whose account is outside them authenticates holding
   * nothing at all.
   *
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the client acts as.
   * @param string $scope
   *   The scope id the client is registered for.
   *
   * @return \Drupal\consumers\Entity\Consumer
   *   The consumer, created on first ask and returned as-is after.
   */
  private function oauthClient(AccountInterface $user, string $scope): Consumer {
    $storage = $this->container->get('entity_type.manager')->getStorage('consumer');
    $client_id = "$scope-client-" . $user->id();
    $existing = $storage->loadByProperties(['client_id' => $client_id]);
    if ($existing !== []) {
      return reset($existing);
    }

    $role = (string) ($this->config("simple_oauth.oauth2_scope.$scope")->get('granularity_configuration.role') ?? '');
    if ($role !== '' && $user instanceof UserInterface && !in_array($role, $user->getRoles(), TRUE)) {
      $user->addRole($role);
      $user->save();
    }

    $consumer = $storage->create([
      'label' => "Client for $scope",
      'client_id' => $client_id,
      'user_id' => $user->id(),
      'confidential' => TRUE,
      'grant_types' => ['client_credentials'],
      'scopes' => [['scope_id' => $scope]],
    ]);
    $consumer->save();
    return $consumer;
  }

}
