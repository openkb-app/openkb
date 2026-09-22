<?php

declare(strict_types=1);

namespace Drupal\simple_oauth_personal_consumers\Controller;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Url;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use Drupal\user\UserInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * The "API clients" profile page: own consumers, create form, revoke links.
 */
class PersonalConsumersController extends ControllerBase {

  public function __construct(
    protected PersonalConsumerManagerInterface $manager,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    return new static($container->get('simple_oauth_personal_consumers.manager'));
  }

  /**
   * Access: only the account's own page, with the self-service permission.
   */
  public function access(UserInterface $user, AccountInterface $account): AccessResult {
    return AccessResult::allowedIf((int) $account->id() === (int) $user->id())
      ->andIf(AccessResult::allowedIfHasPermission($account, 'manage own personal consumers'))
      ->cachePerUser();
  }

  /**
   * Renders the personal consumers page.
   */
  public function page(UserInterface $user): array {
    $build['create'] = $this->formBuilder()->getForm('\Drupal\simple_oauth_personal_consumers\Form\PersonalConsumerCreateForm', $user);

    $rows = [];
    foreach ($this->manager->getConsumers($user) as $consumer) {
      $revoked = $this->manager->isRevoked($consumer);
      $rows[] = [
        $consumer->label(),
        $consumer->getClientId(),
        $revoked ? $this->t('Revoked') : $this->t('Active'),
        [
          'data' => $revoked ? [] : [
            '#type' => 'link',
            '#title' => $this->t('Revoke'),
            '#url' => Url::fromRoute('simple_oauth_personal_consumers.revoke', [
              'user' => $user->id(),
              'consumer' => $consumer->id(),
            ]),
          ],
        ],
      ];
    }

    $build['clients'] = [
      '#type' => 'table',
      '#header' => [
        $this->t('Client'),
        $this->t('Client ID'),
        $this->t('Status'),
        $this->t('Operations'),
      ],
      '#rows' => $rows,
      '#empty' => $this->t('No API clients yet.'),
      '#cache' => [
        'tags' => ['consumer_list'],
      ],
    ];

    return $build;
  }

}
