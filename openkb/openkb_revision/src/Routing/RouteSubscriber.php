<?php

declare(strict_types=1);

namespace Drupal\openkb_revision\Routing;

use Drupal\Core\Routing\RouteSubscriberBase;
use Drupal\openkb_revision\Controller\NodeRevisionHistoryController;
use Symfony\Component\Routing\RouteCollection;

/**
 * A custom-elements variant of core's node revision history.
 */
final class RouteSubscriber extends RouteSubscriberBase {

  /**
   * {@inheritdoc}
   */
  protected function alterRoutes(RouteCollection $collection): void {
    // A CE variant of core's revision history, named and cloned the way
    // lupus_ce_renderer clones the other node view routes. Cloning keeps one
    // definition of what /node/{node}/revisions is — its parameter conversion,
    // and the access the *Revisions* local task is shown by — so that task's
    // URL is a URL this app can serve itself.
    if ($route = $collection->get('entity.node.version_history')) {
      // Added, not substituted: core's revision permission stands and this asks
      // the question it omits, on the core route too — see
      // NodeRevisionHistoryController::readable().
      $route->setRequirement('_custom_access', NodeRevisionHistoryController::class . '::readable');

      $ce_route = clone $route;
      $ce_route->setRequirement('_format', 'custom_elements');
      $ce_route->setDefault('_controller', NodeRevisionHistoryController::class . '::history');
      $collection->add('custom_elements.entity.node.version_history', $ce_route);
    }
  }

}
