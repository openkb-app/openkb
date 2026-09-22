<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Routing;

use Drupal\Core\Routing\RouteSubscriberBase;
use Symfony\Component\Routing\RouteCollection;

/**
 * Lets OAuth2 bearer tokens onto mcp_server's endpoint.
 *
 * The module ships `_auth: ['cookie']`, which excludes every other provider —
 * and an agent's credential is a bearer token, not a browser session. Both
 * stay: the chat's own browser session reaches the endpoint the cookie way.
 */
final class McpAuthRouteSubscriber extends RouteSubscriberBase {

  /**
   * {@inheritdoc}
   */
  protected function alterRoutes(RouteCollection $collection): void {
    if ($route = $collection->get('mcp_server.handle')) {
      $route->setOption('_auth', ['oauth2', 'cookie']);
    }
  }

}
