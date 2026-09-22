<?php

declare(strict_types=1);

namespace Drupal\openkb_collab_api\Controller;

use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Session\AccountProxyInterface;
use Drupal\node\NodeInterface;
use Drupal\openkb_collab_api\Access\SessionFieldAccess;
use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;

/**
 * Answers the collaboration server's join gate for one node.
 *
 * Admission is the security boundary (ADR 0003): the Y.Doc is a shared buffer,
 * so whoever joins can influence content a later checkpoint commits under
 * someone else's credentials. Two Drupal decisions bound it — node update
 * access, and edit access to each field the session exposes — and this route
 * answers both, plus the account it answered for, so a join costs one request.
 *
 * The answer is this account's alone and is never cached: a plain JsonResponse
 * carries no cacheability, so no Drupal cache layer stores it.
 */
final class JoinAccessController implements ContainerInjectionInterface {

  /**
   * Constructs the controller.
   */
  public function __construct(
    private readonly SessionFieldAccess $sessionFieldAccess,
    private readonly AccountProxyInterface $currentUser,
    private readonly LoggerInterface $logger,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get('openkb_collab_api.session_field_access'),
      $container->get('current_user'),
      $container->get('logger.channel.openkb_collab_api'),
    );
  }

  /**
   * Reports whether this account may join a session on this node.
   */
  public function joinAccess(NodeInterface $node): JsonResponse {
    $account = $this->currentUser->getAccount();
    $update = $node->access('update', $account);
    $denied = $this->sessionFieldAccess->deniedFields($node, $account);
    // Warning is the level core records an access denial at; a refused join is
    // a routine answer, not a fault. Only a refusal the fields alone caused is
    // logged — without update access it says nothing about fields.
    if ($update && $denied) {
      $this->logger->warning('Refusing @account the collaborative session on node @nid: no edit access to @fields.', [
        '@account' => $account->getAccountName() ?: 'anonymous',
        '@nid' => $node->id(),
        '@fields' => implode(', ', $denied),
      ]);
    }

    return new JsonResponse([
      'account' => [
        'uid' => (int) $account->id(),
        'name' => $account->getAccountName(),
      ],
      'update' => $update,
      'denied_fields' => $denied,
    ]);
  }

}
