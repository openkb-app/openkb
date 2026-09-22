<?php

declare(strict_types=1);

namespace Drupal\openkb_agent_registration;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Component\Uuid\UuidInterface;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\openkb_agent\ActingIdentity;
use Drupal\simple_oauth\Oauth2ScopeProviderInterface;

/**
 * Turns an RFC 7591 registration request into a consumer, under site policy.
 *
 * Every decision a self-registration involves is made here and configured in
 * `openkb_agent_registration.settings`, so what a pasted URL can turn into is
 * a property of the site rather than of the frontend that relayed the request.
 * The registrant is anonymous and its `client_name` is self-asserted, which
 * shapes all of it:
 *
 * - the client is **public** — no secret is issued, and PKCE S256 is required,
 *   because there is nowhere for such a client to keep a secret;
 * - a registration asking beyond the configured ceiling is **refused**, never
 *   quietly narrowed, so what a client holds is always what it asked for;
 * - its label carries {@see ActingIdentity::UNVERIFIED_SUFFIX}, so every place
 *   attribution appears says the name is self-asserted;
 * - it is a personal consumer with no owner yet: whoever authorizes it first
 *   becomes its owner
 *   ({@see \Drupal\openkb_agent_registration\Hook\RegistrationHooks}), so it
 *   lists and revokes on their profile like any other agent token;
 * - authorization is never automatic: a human sees the consent screen naming
 *   the client before anything is issued.
 *
 * The result is an ordinary consumer entity — listed, editable and revocable
 * in the admin UI like any other.
 */
final class ClientRegistrar {

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly ConfigFactoryInterface $configFactory,
    private readonly UuidInterface $uuid,
    private readonly TimeInterface $time,
    private readonly Oauth2ScopeProviderInterface $scopeProvider,
  ) {}

  /**
   * Registers a client from its RFC 7591 metadata.
   *
   * @param array $metadata
   *   The client metadata as posted.
   *
   * @return array
   *   The RFC 7591 client information response.
   *
   * @throws \Drupal\openkb_agent_registration\RegistrationException
   *   When the metadata is unusable or policy refuses it.
   */
  public function register(array $metadata): array {
    $settings = $this->configFactory->get('openkb_agent_registration.settings');
    if (!$settings->get('enabled')) {
      throw new RegistrationException('invalid_client_metadata', 'Client registration is disabled on this site.', 403);
    }

    $redirect_uris = $this->redirectUris($metadata);
    $label = $this->clientName($metadata) . ActingIdentity::UNVERIFIED_SUFFIX;
    $granted = $this->grantedScopes($metadata);
    $client_id = $this->uuid->generate();

    /** @var \Drupal\consumers\Entity\ConsumerInterface $consumer */
    $consumer = $this->entityTypeManager->getStorage('consumer')->create([
      'label' => $label,
      'client_id' => $client_id,
      'grant_types' => ['authorization_code', 'refresh_token'],
      'redirect' => $redirect_uris,
      'confidential' => FALSE,
      'pkce' => TRUE,
      'automatic_authorization' => FALSE,
      'is_default' => FALSE,
      'third_party' => TRUE,
      'authorization_code_scopes' => array_keys($granted),
      // Owner-bound and self-service like a token provisioned on a profile —
      // it is simply nobody's until the first person consents to it.
      'personal' => TRUE,
    ]);
    $consumer->save();

    return [
      'client_id' => $client_id,
      'client_id_issued_at' => $this->time->getRequestTime(),
      // The name as registered, marking included: RFC 7591 §3.2.1 has the
      // server state the metadata it actually stored, not what was asked for.
      'client_name' => $label,
      'redirect_uris' => $redirect_uris,
      'grant_types' => ['authorization_code', 'refresh_token'],
      'response_types' => ['code'],
      // No secret is issued, so there is nothing to authenticate the client
      // with at the token endpoint; PKCE carries the proof instead.
      'token_endpoint_auth_method' => 'none',
      'scope' => implode(' ', $granted),
    ];
  }

  /**
   * The scopes a self-registered client may be granted, id => wire name.
   *
   * The ceiling is config, and two names for one scope meet here: config and
   * the consumer field address a scope by its **id** (`agent_read`), the OAuth
   * wire by its **name** (`agent:read`). This is also what the site advertises
   * as `scopes_supported`, so a client asks for what it can actually have.
   *
   * @return array<string, string>
   *   The offered scopes, id => name.
   */
  public function offeredScopes(): array {
    $ceiling = $this->configFactory->get('openkb_agent_registration.settings')->get('scopes') ?? [];
    $offered = [];
    foreach ($this->scopeProvider->loadMultiple(array_values(array_filter($ceiling, 'is_string'))) as $scope) {
      $offered[$scope->id()] = $scope->getName();
    }
    return $offered;
  }

  /**
   * The scopes to grant: exactly what was asked for, or a refusal.
   *
   * A request naming nothing gets the whole ceiling — the client is saying
   * "whatever you allow". A request naming anything the ceiling does not cover
   * is refused, so a client is never handed a narrower grant than it asked for
   * and left to discover it by being denied later.
   *
   * @return array<string, string>
   *   The granted scopes, id => name.
   */
  private function grantedScopes(array $metadata): array {
    $available = $this->offeredScopes();
    if ($available === []) {
      throw new RegistrationException('invalid_client_metadata', 'No scope ceiling is configured for self-registered clients.', 403);
    }

    $requested = $metadata['scope'] ?? NULL;
    if (!is_string($requested) || trim($requested) === '') {
      return $available;
    }
    $names = preg_split('/\s+/', trim($requested)) ?: [];
    $beyond = array_diff($names, $available);
    if ($beyond !== []) {
      throw new RegistrationException('invalid_client_metadata', sprintf('Not available to a self-registered client: %s. This site grants: %s.', implode(' ', $beyond), implode(' ', $available)));
    }
    return array_filter($available, static fn (string $name): bool => in_array($name, $names, TRUE));
  }

  /**
   * The client's display name, self-asserted and therefore length-capped.
   */
  private function clientName(array $metadata): string {
    $name = is_string($metadata['client_name'] ?? NULL) ? trim($metadata['client_name']) : '';
    if ($name === '') {
      throw new RegistrationException('invalid_client_metadata', 'client_name is required.');
    }
    // The consumer label column is 255; a longer name is a mistake or an
    // attempt to crowd out the marking the label carries.
    return mb_substr($name, 0, 100);
  }

  /**
   * The redirect URIs, validated.
   *
   * @return string[]
   *   The validated redirect URIs.
   */
  private function redirectUris(array $metadata): array {
    $uris = $metadata['redirect_uris'] ?? NULL;
    if (!is_array($uris) || $uris === []) {
      throw new RegistrationException('invalid_redirect_uri', 'redirect_uris is required and must list at least one URI.');
    }
    foreach ($uris as $uri) {
      if (!is_string($uri) || !self::isAllowedRedirectUri($uri)) {
        throw new RegistrationException('invalid_redirect_uri', sprintf('Not an acceptable redirect URI: %s. Use https, or http on a loopback address (RFC 8252 §7.3).', is_string($uri) ? $uri : gettype($uri)));
      }
    }
    return array_values($uris);
  }

  /**
   * Whether a redirect URI may be registered.
   *
   * HTTPS everywhere, plus http on a loopback address — which native clients
   * need, since they receive the code on a local listener and have no
   * certificate to serve it over TLS. A fragment is never part of a redirect
   * URI (RFC 6749 §3.1.2).
   */
  public static function isAllowedRedirectUri(string $uri): bool {
    $parts = parse_url($uri);
    if ($parts === FALSE || !isset($parts['scheme'], $parts['host']) || isset($parts['fragment'])) {
      return FALSE;
    }
    $scheme = strtolower($parts['scheme']);
    if ($scheme === 'https') {
      return TRUE;
    }
    return $scheme === 'http'
      && in_array(strtolower($parts['host']), ['127.0.0.1', '[::1]', '::1', 'localhost'], TRUE);
  }

}
