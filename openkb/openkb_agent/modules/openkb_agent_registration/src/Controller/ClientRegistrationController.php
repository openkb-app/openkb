<?php

declare(strict_types=1);

namespace Drupal\openkb_agent_registration\Controller;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Cache\CacheableJsonResponse;
use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\openkb_agent_registration\ClientRegistrar;
use Drupal\openkb_agent_registration\RegistrationException;
use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * The internal bridge behind the frontend's `/register` pass-through.
 *
 * Dynamic client registration (RFC 7591) is what lets a human paste the MCP
 * URL into a client and be connected without provisioning anything by hand.
 * The wire endpoint lives in Nitro; every decision lives here, because what a
 * pasted URL may turn into is a property of the site.
 *
 * The bridge is internal: it is reachable only by a caller holding
 * `use client registration api` — the collaboration server's own OAuth client
 * (ADR 0001), never the registrant, who has no account to authenticate. It
 * grants no access of its own: what it creates is a public client that still
 * has to walk a human through `/oauth/authorize` before any token exists.
 *
 * What the site *offers* a registration is public, and served as such by
 * {@see self::metadata()} — the frontend's OAuth metadata documents advertise
 * it, so a client asks for scopes it can actually have.
 */
final class ClientRegistrationController implements ContainerInjectionInterface {

  public function __construct(
    private readonly ClientRegistrar $registrar,
    private readonly ConfigFactoryInterface $configFactory,
    private readonly LoggerInterface $logger,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get('openkb_agent_registration.client_registrar'),
      $container->get('config.factory'),
      $container->get('logger.channel.openkb_agent_registration'),
    );
  }

  /**
   * Registers a client, or says why not.
   */
  public function register(Request $request): JsonResponse {
    $metadata = Json::decode((string) $request->getContent());
    if (!is_array($metadata)) {
      return $this->error('invalid_client_metadata', 'The request body must be a JSON object of client metadata.');
    }

    try {
      $client = $this->registrar->register($metadata);
    }
    catch (RegistrationException $e) {
      return $this->error($e->error, $e->getMessage(), $e->statusCode);
    }

    $this->logger->notice('Registered client %name (%client_id) with scopes %scopes.', [
      '%name' => $client['client_name'],
      '%client_id' => $client['client_id'],
      '%scopes' => $client['scope'],
    ]);
    return new JsonResponse($client, 201);
  }

  /**
   * What a registration may ask for, by wire name.
   *
   * Public: it is the same list the OAuth metadata documents publish, and a
   * client has to read it before it holds any credential.
   */
  public function metadata(): CacheableJsonResponse {
    $response = new CacheableJsonResponse([
      'scopes_supported' => array_values($this->registrar->offeredScopes()),
    ]);
    return $response->addCacheableDependency(
      CacheableMetadata::createFromObject($this->configFactory->get('openkb_agent_registration.settings')),
    );
  }

  /**
   * An RFC 7591 §3.2.2 error response.
   */
  private function error(string $error, string $description, int $status = 400): JsonResponse {
    return new JsonResponse([
      'error' => $error,
      'error_description' => $description,
    ], $status);
  }

}
