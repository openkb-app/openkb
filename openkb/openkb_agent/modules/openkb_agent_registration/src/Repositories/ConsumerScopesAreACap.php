<?php

declare(strict_types=1);

namespace Drupal\openkb_agent_registration\Repositories;

use Drupal\simple_oauth\Entities\ClientEntity;
use League\OAuth2\Server\Entities\ClientEntityInterface;
use League\OAuth2\Server\Entities\ScopeEntityInterface;
use League\OAuth2\Server\Exception\OAuthServerException;
use League\OAuth2\Server\Repositories\ScopeRepositoryInterface;

/**
 * Refuses an authorization-code request asking beyond the consumer's scopes.
 *
 * Simple_oauth reads a consumer's scope field two ways: for the
 * client-credentials grant it is a cap and a request beyond it is refused with
 * `invalid_scope`, while for the authorization-code grant the same field is
 * only a default and a client gets whatever it puts in the `scope` parameter
 * ([#3398468](https://www.drupal.org/project/simple_oauth/issues/3398468),
 * intentional upstream). A client that registered itself is capped at what the
 * site granted it at registration, so that read would leave the ceiling
 * decorative — the client could ask for the full set on `/oauth/authorize` one
 * request later.
 *
 * This closes it by giving the authorization-code grant the same answer the
 * client-credentials one already gets, without touching `/oauth/*` or
 * simple_oauth's config. Refused rather than narrowed: a client that asked for
 * something it may not have is told so, instead of holding a token whose
 * limits it has to discover by being denied later. League calls this at the
 * token endpoint, so the refusal reaches the client as an `invalid_scope`
 * token response.
 *
 * A consumer whose scope field is empty is not capped by anything and is left
 * exactly as simple_oauth handles it.
 */
final class ConsumerScopesAreACap implements ScopeRepositoryInterface {

  public function __construct(
    private readonly ScopeRepositoryInterface $inner,
  ) {}

  /**
   * {@inheritdoc}
   */
  public function getScopeEntityByIdentifier(string $identifier): ?ScopeEntityInterface {
    return $this->inner->getScopeEntityByIdentifier($identifier);
  }

  /**
   * {@inheritdoc}
   */
  public function finalizeScopes(
    array $scopes,
    string $grantType,
    ClientEntityInterface $clientEntity,
    string|null $userIdentifier = NULL,
    ?string $authCodeId = NULL,
  ): array {
    // An empty request is not a request for more: simple_oauth answers it with
    // the consumer's own scopes, which are the cap itself.
    $cap = $grantType === 'authorization_code' && $scopes !== []
      ? $this->cap($clientEntity)
      : NULL;
    if ($cap !== NULL) {
      foreach ($scopes as $scope) {
        if (!in_array($scope->getIdentifier(), $cap, TRUE)) {
          throw OAuthServerException::invalidScope($scope->getIdentifier());
        }
      }
    }
    return $this->inner->finalizeScopes($scopes, $grantType, $clientEntity, $userIdentifier, $authCodeId);
  }

  /**
   * The scopes a client may hold, or NULL when nothing caps it.
   *
   * By **name** (`agent:read`), which is how the OAuth wire — and so
   * `ScopeEntityInterface::getIdentifier()` — addresses a scope; the consumer
   * field stores ids.
   *
   * @return string[]|null
   *   The scope names, or NULL when no cap applies.
   */
  private function cap(ClientEntityInterface $clientEntity): ?array {
    if (!$clientEntity instanceof ClientEntity) {
      return NULL;
    }
    $field = $clientEntity->getDrupalEntity()->get('authorization_code_scopes');
    if ($field->isEmpty()) {
      return NULL;
    }
    /** @var \Drupal\simple_oauth\Plugin\Field\FieldType\Oauth2ScopeReferenceItemListInterface $field */
    return array_map(static fn ($scope): string => $scope->getName(), $field->getScopes());
  }

}
