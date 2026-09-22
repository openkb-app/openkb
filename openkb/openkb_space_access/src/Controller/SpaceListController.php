<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access\Controller;

use Drupal\Core\Cache\CacheableJsonResponse;
use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\openkb_space_access\SpaceAccessMap;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;

/**
 * Where the caller may work.
 *
 *   GET /openkb/spaces[?q=…][&access=read|write|manage]
 *
 * Self-scoped: it answers for the authenticated caller and lists nothing that
 * caller cannot at least read, so there is no way to read the site's space
 * directory out of it. `access` is a minimum, not an equality — asking for
 * `write` also returns the spaces the caller manages, because those are places
 * it may write.
 *
 * This is the product's answer to "which spaces are mine, and what may I do in
 * them", not an agent affordance: a space picker and any UI that would
 * otherwise infer access by reading rosters belong on it. The
 * `tool_api__list_spaces` tool is the same data through
 * {@see \Drupal\openkb_space_access\SpaceAccessMap}, not a second
 * implementation.
 */
final class SpaceListController implements ContainerInjectionInterface {

  public function __construct(
    private readonly SpaceAccessMap $accessMap,
    private readonly AccountInterface $currentUser,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get(SpaceAccessMap::class),
      $container->get('current_user'),
    );
  }

  /**
   * Lists the caller's spaces.
   */
  public function list(Request $request): CacheableJsonResponse {
    $access = (string) $request->query->get('access', SpaceAccessMap::READ);
    if (!in_array($access, [SpaceAccessMap::READ, SpaceAccessMap::WRITE, SpaceAccessMap::MANAGE], TRUE)) {
      throw new BadRequestHttpException(sprintf('Unknown access level "%s".', $access));
    }

    $cacheability = new CacheableMetadata();
    $spaces = $this->accessMap->list($this->currentUser, [
      'q' => (string) $request->query->get('q', ''),
      'access' => $access,
    ], $cacheability);
    // Both filters are part of the answer, not of the account.
    $cacheability->addCacheContexts(['url.query_args:q', 'url.query_args:access']);

    $response = new CacheableJsonResponse(['spaces' => $spaces]);
    $response->addCacheableDependency($cacheability);
    return $response;
  }

}
