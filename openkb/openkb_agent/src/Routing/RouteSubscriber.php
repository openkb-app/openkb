<?php

declare(strict_types=1);

namespace Drupal\openkb_agent\Routing;

use Drupal\Core\Routing\RouteSubscriberBase;
use Drupal\openkb_agent\Controller\ApiClientsCeController;
use Drupal\openkb_agent\Controller\Oauth2AuthorizeCeController;
use Symfony\Component\Routing\RouteCollection;

/**
 * Labels the personal-consumer routes, and opens them to the frontend.
 *
 * The custom-elements variants are clones: the originals are left alone and go
 * on answering in HTML, while a request asking for the `custom_elements` format
 * resolves here instead — which is what `/ce-api` makes of one, and equally
 * what `?_format=custom_elements` asks for directly. Being clones they carry
 * the same access requirements, so the second way in exposes nothing the first
 * does not. Same pattern lupus_decoupled_user_form uses for `user.login`.
 */
final class RouteSubscriber extends RouteSubscriberBase {

  /**
   * {@inheritdoc}
   */
  protected function alterRoutes(RouteCollection $collection): void {
    // In OpenKB the personal-consumers pages are agent tokens.
    if ($route = $collection->get('simple_oauth_personal_consumers.collection')) {
      $route->setDefault('_title', 'Agent tokens');
      $ce_route = clone $route;
      $ce_route->setRequirement('_format', 'custom_elements');
      // The frontend surface is about connecting an agent, not only about the
      // tokens listed on it, and its window title says so.
      $ce_route->setDefault('_title', 'Agents & API clients');
      $ce_route->setDefault('_controller', ApiClientsCeController::class . '::customElementsPage');
      $collection->add('openkb_agent.api_clients.ce', $ce_route);
    }
    if ($route = $collection->get('simple_oauth_personal_consumers.revoke')) {
      $route->setDefault('_title', 'Revoke agent token');
      // The confirm form needs no controller of its own — a CE form controller
      // builds whatever the route's `_form` names.
      $ce_route = clone $route;
      $ce_route->setRequirement('_format', 'custom_elements');
      $ce_route->setDefault('_controller', 'openkb_agent.controller.titled_form:getContentResult');
      $collection->add('openkb_agent.api_clients_revoke.ce', $ce_route);
    }

    // The consent screen, so the frontend can render it in its own theme.
    if ($route = $collection->get('oauth2_token.authorize')) {
      $ce_route = clone $route;
      $ce_route->setRequirement('_format', 'custom_elements');
      $ce_route->setDefault('_controller', Oauth2AuthorizeCeController::class . '::authorize');
      $collection->add('openkb_agent.oauth2_authorize.ce', $ce_route);
    }
  }

}
