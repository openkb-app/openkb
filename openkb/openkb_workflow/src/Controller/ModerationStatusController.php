<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow\Controller;

use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\node\NodeInterface;
use Drupal\openkb_workflow\ModerationStatus;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Serves the moderation status of one page.
 *
 * GET /openkb/node/{node}/moderation is the only source of the status. The
 * read page requests it after mount; the .md and MCP lanes request it
 * server-side. Access is `node.update`. Any other bundle 404s.
 */
final class ModerationStatusController implements ContainerInjectionInterface {

  public function __construct(
    private readonly ModerationStatus $moderationStatus,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self($container->get('openkb_workflow.moderation_status'));
  }

  /**
   * Reports the moderation status of one page.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page, as resolved by the route (its default revision).
   *
   * @return \Symfony\Component\HttpFoundation\JsonResponse
   *   The status document.
   */
  public function status(NodeInterface $node): JsonResponse {
    if ($node->bundle() !== ModerationStatus::BUNDLE) {
      // The endpoint is kb_page-only, like the commit route.
      throw new NotFoundHttpException(sprintf('The moderation endpoint only accepts %s nodes.', ModerationStatus::BUNDLE));
    }

    return new JsonResponse($this->moderationStatus->of($node));
  }

}
