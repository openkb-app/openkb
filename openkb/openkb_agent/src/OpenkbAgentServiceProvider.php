<?php

declare(strict_types=1);

namespace Drupal\openkb_agent;

use Drupal\Core\DependencyInjection\ContainerBuilder;
use Drupal\Core\DependencyInjection\ServiceProviderBase;

/**
 * Declares the API-clients pages as frontend paths.
 *
 * These pages live in the app, so lupus_decoupled owns their URLs: it marks
 * every route on these paths `_lupus_frontend`, sends a browser that reaches
 * one on the backend to the app, and generates their URLs against the frontend
 * base URL — the redirect a revoke answers with included.
 *
 * Registering the path is the whole of it. A module that rewrites a generated
 * URL afterwards is deciding for itself something the framework decides from
 * one declaration.
 */
final class OpenkbAgentServiceProvider extends ServiceProviderBase {

  /**
   * The parameter lupus_decoupled_ce_api reads its frontend paths from.
   */
  private const PARAMETER = 'lupus_decoupled_ce_api.frontend_paths';

  /**
   * Route paths this module serves through the frontend.
   */
  private const FRONTEND_PATHS = [
    '/user/{user}/api-clients',
    '/user/{user}/api-clients/{consumer}/revoke',
  ];

  /**
   * {@inheritdoc}
   */
  public function alter(ContainerBuilder $container): void {
    // Absent wherever the module is installed without lupus_decoupled_ce_api,
    // which is how the kernel suite runs it.
    if (!$container->hasParameter(self::PARAMETER)) {
      return;
    }
    $paths = array_merge((array) $container->getParameter(self::PARAMETER), self::FRONTEND_PATHS);
    $container->setParameter(self::PARAMETER, array_values(array_unique($paths)));
  }

}
