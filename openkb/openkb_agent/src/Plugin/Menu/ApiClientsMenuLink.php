<?php

declare(strict_types=1);

namespace Drupal\openkb_agent\Plugin\Menu;

use Drupal\Core\Menu\MenuLinkDefault;
use Drupal\Core\Menu\StaticMenuLinkOverridesInterface;
use Drupal\Core\Session\AccountInterface;

/**
 * The account menu's link to the signed-in account's own API-clients page.
 *
 * The route is per-account (`/user/{user}/api-clients`), which a static link
 * definition cannot name — so the parameter is resolved on the link, the way
 * core's LoginLogoutMenuLink resolves its route.
 */
final class ApiClientsMenuLink extends MenuLinkDefault {

  /**
   * The account the link points at, which is whoever is asking.
   *
   * Not promoted: DependencySerializationTrait, which the parent brings,
   * cannot restore a private or readonly property declared here.
   */
  protected AccountInterface $currentUser;

  public function __construct(
    array $configuration,
    $plugin_id,
    $plugin_definition,
    StaticMenuLinkOverridesInterface $static_override,
    AccountInterface $current_user,
  ) {
    parent::__construct($configuration, $plugin_id, $plugin_definition, $static_override);
    $this->currentUser = $current_user;
  }

  /**
   * {@inheritdoc}
   */
  public function getRouteParameters() {
    return ['user' => $this->currentUser->id()];
  }

  /**
   * {@inheritdoc}
   */
  public function getCacheContexts() {
    return ['user'];
  }

}
