<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\Core\Url;
use Drupal\KernelTests\KernelTestBase;

/**
 * The API-clients pages are declared frontend paths (OKB-162).
 *
 * The module says once, in the container, that these paths are served by the
 * app; lupus_decoupled does the rest. What that buys is asserted here at its
 * end: an absolute URL for the listing — which is what a revoke redirects to,
 * because Drupal builds every form redirect absolute — addresses the frontend
 * rather than the backend the request came in on.
 */
final class ApiClientsFrontendPathTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'file',
    'image',
    // consumer's grant_types is a list_string.
    'options',
    'serialization',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'custom_elements',
    'token',
    'metatag',
    'path_alias',
    'lupus_ce_renderer',
    'lupus_decoupled_ce_api',
    'openkb_agent',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('path_alias');
    $this->installConfig(['lupus_decoupled_ce_api']);
    $this->config('lupus_decoupled_ce_api.settings')
      ->set('frontend_base_url', 'https://frontend.example.com')
      ->set('frontend_routes_redirect', TRUE)
      ->save();
  }

  /**
   * Both pages are registered, so neither half of the round trip is left out.
   */
  public function testPathsAreRegistered(): void {
    $paths = (array) $this->container->getParameter('lupus_decoupled_ce_api.frontend_paths');
    $this->assertContains('/user/{user}/api-clients', $paths);
    $this->assertContains('/user/{user}/api-clients/{consumer}/revoke', $paths);
  }

  /**
   * The stock route and its CE clone are both frontend routes.
   */
  public function testRoutesAreMarkedFrontend(): void {
    $provider = $this->container->get('router.route_provider');
    foreach (['simple_oauth_personal_consumers.collection', 'openkb_agent.api_clients.ce'] as $name) {
      $this->assertTrue($provider->getRouteByName($name)->getOption('_lupus_frontend'), $name);
    }
  }

  /**
   * An absolute listing URL addresses the frontend.
   */
  public function testAbsoluteUrlAddressesTheFrontend(): void {
    // The environment may advertise a frontend of its own, and does in the
    // container the suite runs in; either way the provider is the authority.
    $frontend = $this->container->get('lupus_decoupled_ce_api.base_url_provider')->getFrontendBaseUrl();
    $this->assertNotEmpty($frontend);
    $url = Url::fromRoute('simple_oauth_personal_consumers.collection', ['user' => 2], ['absolute' => TRUE])->toString();
    $this->assertStringStartsWith($frontend . '/user/2/api-clients', $url);
  }

}
