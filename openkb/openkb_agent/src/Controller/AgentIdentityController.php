<?php

declare(strict_types=1);

namespace Drupal\openkb_agent\Controller;

use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\openkb_agent\ActingIdentity;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;

/**
 * Reports the acting identity of the current request.
 *
 * The contract the frontend server layer builds on: `uid`/`name` are always
 * the human account the request acts as; `via` carries the agent client's
 * label ("claude") when the request authenticated with an agent token, NULL
 * for a regular session. The frontend renders "editor1 via claude" from it.
 *
 * `scopes` exists so the frontend can name *which* ceiling a request falls
 * short of — the collab session-join gate reports "agent_write scope required"
 * instead of a generic denial.
 *
 * The resolution itself is \Drupal\openkb_agent\ActingIdentity, shared with
 * the presave attribution that credits blocks to the same identity — so what
 * the editor displays and what the sidecar records cannot disagree.
 */
final class AgentIdentityController implements ContainerInjectionInterface {

  public function __construct(
    private readonly ActingIdentity $identity,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self($container->get('openkb_agent.acting_identity'));
  }

  /**
   * Returns the acting identity as JSON.
   */
  public function identity(): JsonResponse {
    return new JsonResponse([
      'uid' => $this->identity->uid(),
      'name' => $this->identity->name(),
      'via' => $this->identity->via(),
      'scopes' => $this->identity->scopes(),
    ]);
  }

}
