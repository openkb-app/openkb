<?php

declare(strict_types=1);

namespace Drupal\openkb_collab_api\EventSubscriber;

use Drupal\openkb_collab_api\StaleCommitException;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Renders a refused stale commit as the two timestamps that disagree.
 *
 * JSON:API's own exception normalizer renders any exception as title / status
 * / detail and nothing else, so the timestamps handed to it would survive only
 * as a sentence. This subscriber runs ahead of it for this one exception and
 * writes the document itself — see
 * \Drupal\openkb_collab_api\StaleCommitException::toDocument().
 */
final class StaleCommitSubscriber implements EventSubscriberInterface {

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    // Ahead of JSON:API's own exception subscriber (priority 0 downwards),
    // which would otherwise flatten the timestamps into the detail sentence.
    return [KernelEvents::EXCEPTION => ['onException', 128]];
  }

  /**
   * Writes the conflict document.
   *
   * @param \Symfony\Component\HttpKernel\Event\ExceptionEvent $event
   *   The exception event.
   */
  public function onException(ExceptionEvent $event): void {
    $exception = $event->getThrowable();
    if (!$exception instanceof StaleCommitException) {
      return;
    }
    $event->setResponse(new JsonResponse(
      $exception->toDocument(),
      $exception->getStatusCode(),
      // The frontend parses the error taxonomy JSON:API speaks, and this is
      // one of its documents — announcing it as anything else would send the
      // refusal down a different branch than every other write failure.
      ['Content-Type' => 'application/vnd.api+json'],
    ));
  }

}
