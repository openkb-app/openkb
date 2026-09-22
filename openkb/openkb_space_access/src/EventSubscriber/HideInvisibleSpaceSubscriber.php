<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access\EventSubscriber;

use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\openkb_space_access\SpaceAccess;
use Drupal\openkb_space_access\SpaceAccessPolicy;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Answers 404, not 403, for anything inside a space the session cannot read.
 *
 * A 403 confirms that the path exists — for a private space that is exactly the
 * fact being kept: non-members are not told a space or a page is there at
 * all. Everywhere else in the system this falls out of the query filtering
 * (nothing is listed, so nothing is linked); the routed entity is the one place
 * where Drupal has already resolved the path and would answer "forbidden".
 *
 * Only spaces are rewritten. A 403 for any other reason — an unpublished node,
 * a missing permission — keeps its own meaning.
 */
final class HideInvisibleSpaceSubscriber implements EventSubscriberInterface {

  public function __construct(
    private readonly SpaceAccess $spaceAccess,
    private readonly AccountInterface $currentUser,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    // Ahead of every subscriber that turns an exception into a response.
    return [KernelEvents::EXCEPTION => ['onException', 100]];
  }

  /**
   * Rewrites the access denial for an entity in an unreadable space.
   */
  public function onException(ExceptionEvent $event): void {
    if (!$event->getThrowable() instanceof AccessDeniedHttpException) {
      return;
    }

    foreach ($event->getRequest()->attributes->all() as $value) {
      if ($value instanceof EntityInterface && $this->isHidden($value)) {
        $event->setThrowable(new NotFoundHttpException());
        return;
      }
    }
  }

  /**
   * Whether an entity belongs to a space the current user may not read.
   */
  private function isHidden(EntityInterface $entity): bool {
    $id = $this->spaceAccess->spaceIdOf($entity);
    return $id !== NULL
      && !$this->spaceAccess->hasPermission($this->currentUser, $id, SpaceAccessPolicy::VIEW);
  }

}
