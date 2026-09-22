<?php

declare(strict_types=1);

namespace Drupal\openkb_agent\Controller;

use Drupal\Core\Cache\CacheableJsonResponse;
use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Controller\ControllerBase;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use Drupal\user\UserInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * The caller's own agent clients, by the label they act under.
 *
 * A thread is assigned to `{uid, via}`, where `via` is the client's label, so
 * the picker can hand work to an agent that is not in the session — it needs
 * the labels the caller's clients hold, which no session peer reports while
 * the agent is away.
 *
 * A client with no label is left out: nothing names it in a picker, and
 * nothing could be assigned to it.
 */
final class MyAgentsController extends ControllerBase {

  public function __construct(
    private readonly PersonalConsumerManagerInterface $consumers,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    return new static($container->get('simple_oauth_personal_consumers.manager'));
  }

  /**
   * Answers the caller's own clients.
   */
  public function agents(): CacheableJsonResponse {
    $cacheability = (new CacheableMetadata())
      // Per account, and a client registered, renamed or revoked changes it.
      ->setCacheContexts(['user'])
      ->setCacheTags($this->entityTypeManager()->getDefinition('consumer')->getListCacheTags());

    $user = $this->entityTypeManager()->getStorage('user')->load($this->currentUser()->id());
    $agents = [];
    if ($user instanceof UserInterface) {
      foreach ($this->consumers->getConsumers($user) as $consumer) {
        $cacheability->addCacheableDependency($consumer);
        // The label exactly as a token of this client acts under it.
        $label = (string) $consumer->label();
        if (trim($label) === '' || $this->consumers->isRevoked($consumer)) {
          continue;
        }
        $agents[] = ['label' => $label];
      }
    }

    $response = new CacheableJsonResponse(['agents' => $agents]);
    return $response->addCacheableDependency($cacheability);
  }

}
