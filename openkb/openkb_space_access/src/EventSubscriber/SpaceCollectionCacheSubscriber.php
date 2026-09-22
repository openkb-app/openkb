<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access\EventSubscriber;

use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Cache\CacheableResponseInterface;
use Drupal\jsonapi\ResourceType\ResourceType;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Keys a space collection response by the spaces its reader may see.
 *
 * The collection is narrowed per account in SQL by
 * openkb_space_access_query_openkb_space_access_alter(), where a query alter
 * has nowhere to put cacheability. What would otherwise carry it — the
 * per-space access results — is absent exactly when the narrowing leaves
 * nothing, so an account with no spaces produces an empty response that
 * declares no account variance at all. Stored under a key every other account
 * matches, that response is then served to a member, who sees no spaces.
 *
 * Declaring the context here covers both halves: the empty collection, and two
 * accounts whose roles match but whose rosters do not.
 */
final class SpaceCollectionCacheSubscriber implements EventSubscriberInterface {

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    // Ahead of DynamicPageCacheSubscriber::onResponse(), which stores the
    // response under the contexts it carries at priority 100.
    return [KernelEvents::RESPONSE => ['onResponse', 200]];
  }

  /**
   * Adds the space-visibility context to a space collection response.
   */
  public function onResponse(ResponseEvent $event): void {
    $response = $event->getResponse();
    if (!$response instanceof CacheableResponseInterface) {
      return;
    }
    $resource_type = $event->getRequest()->attributes->get('resource_type');
    if (!$resource_type instanceof ResourceType
      || $resource_type->getTypeName() !== 'openkb_space--openkb_space') {
      return;
    }
    $response->addCacheableDependency(
      (new CacheableMetadata())->addCacheContexts(['user.openkb_spaces']),
    );
  }

}
