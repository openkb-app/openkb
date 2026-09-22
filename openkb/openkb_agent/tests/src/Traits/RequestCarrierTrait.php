<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Traits;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AnonymousUserSession;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\Session\Session;
use Symfony\Component\HttpFoundation\Session\Storage\MockArraySessionStorage;

/**
 * Hands a request to the HTTP kernel under a signed-in session.
 *
 * A session cookie is the credential the frontend sends, so access resolves as
 * it does in production. Writes need the session's CSRF header on top.
 */
trait RequestCarrierTrait {

  /**
   * Which account the last request actually authenticated as.
   */
  protected int $authenticatedAs = 0;

  /**
   * Handles one request through the HTTP kernel.
   *
   * @param string $path
   *   The path, as the route declares it.
   * @param \Drupal\Core\Session\AccountInterface|null $user
   *   The account to authenticate as, or NULL to stay anonymous.
   * @param string $method
   *   The HTTP method.
   * @param array|null $payload
   *   A JSON body, or NULL for none.
   * @param array $headers
   *   Extra request headers, unprefixed (name => value).
   *
   * @return \Symfony\Component\HttpFoundation\Response
   *   The response.
   */
  protected function request(
    string $path,
    ?AccountInterface $user = NULL,
    string $method = 'GET',
    ?array $payload = NULL,
    array $headers = [],
  ): Response {
    $request = Request::create(
      $path,
      $method,
      [],
      [],
      [],
      [],
      $payload === NULL ? NULL : Json::encode($payload),
    );
    if ($payload !== NULL) {
      $request->headers->set('Content-Type', 'application/json');
    }
    foreach ($headers as $name => $value) {
      $request->headers->set($name, $value);
    }
    if ($user !== NULL) {
      $this->carrySession($request, $user);
    }

    $http_kernel = $this->container->get('http_kernel');
    $response = $http_kernel->handle($request);
    // A read runs its post-response subscribers: JSON:API writes its
    // normalization cache from one. A write does not — the cacher keeps that
    // normalization queued, and this container outlives the request, so
    // terminating here would hand the queue to the next read.
    if ($request->isMethodCacheable()) {
      $http_kernel->terminate($request, $response);
    }
    $this->authenticatedAs = (int) $this->container->get('current_user')->id();
    // The kernel leaves the account it authenticated as the current user. Put
    // it back, so an assertion reading storage afterwards is not silently
    // making its own access decisions as the caller under test.
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
    return $response;
  }

  /**
   * Puts a signed-in session on a request.
   *
   * Cookie is the only provider a route that names none allows; any other
   * authenticates the account and is then refused for *how* it did so, which
   * reads like a permissions problem. Under CLI core's session middleware
   * leaves the request's own session alone, so a uid plus the cookie is the
   * whole carrier.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request to sign in.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account to sign in as.
   *
   * @see \Drupal\Core\StackMiddleware\Session::handle()
   */
  protected function carrySession(Request $request, AccountInterface $user): void {
    $session = new Session(new MockArraySessionStorage());
    $session->set('uid', (int) $user->id());
    $request->setSession($session);

    $name = $this->container->get('session_configuration')->getOptions($request)['name'];
    $request->cookies->set($name, $session->getId());
  }

  /**
   * The decoded body of a response.
   *
   * @param \Symfony\Component\HttpFoundation\Response $response
   *   The response.
   *
   * @return array
   *   The decoded document.
   */
  protected function decode(Response $response): array {
    $decoded = Json::decode((string) $response->getContent());
    return is_array($decoded) ? $decoded : [];
  }

}
