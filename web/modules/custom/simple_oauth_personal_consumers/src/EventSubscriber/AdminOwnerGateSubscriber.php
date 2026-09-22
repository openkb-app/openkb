<?php

declare(strict_types=1);

namespace Drupal\simple_oauth_personal_consumers\EventSubscriber;

use Drupal\Core\Session\AccountProxyInterface;
use Drupal\simple_oauth\Authentication\TokenAuthUser;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use Drupal\user\UserInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Refuses personal-consumer tokens whose owner has since become an admin.
 *
 * A personal consumer's token is capped at owner ∩ scope, which is only a
 * ceiling as long as the owner is not an administrator — hence the refusal in
 * PersonalConsumerManager::create(). That check binds at provisioning time
 * only, so it is re-applied here on every request the token authenticates:
 * an owner promoted after the fact (a role added to them, or a role they
 * already hold flipped to `is_admin`) must not silently upgrade their live
 * token into an admin credential.
 *
 * The gate is deliberately non-destructive — demoting the owner restores the
 * token — so an accidental promotion does not permanently burn credentials.
 */
final class AdminOwnerGateSubscriber implements EventSubscriberInterface {

  public function __construct(
    private readonly AccountProxyInterface $currentUser,
    private readonly PersonalConsumerManagerInterface $manager,
    private readonly LoggerInterface $logger,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    // Just below AuthenticationSubscriber::onKernelRequestAuthenticate (300),
    // so the authenticated account is on the proxy and nothing has run with it
    // yet.
    return [KernelEvents::REQUEST => [['onRequest', 299]]];
  }

  /**
   * Denies the request when the authenticated token's owner is an admin.
   */
  public function onRequest(RequestEvent $event): void {
    if (!$event->isMainRequest()) {
      return;
    }
    $account = $this->currentUser->getAccount();
    if (!$account instanceof TokenAuthUser) {
      return;
    }
    $consumer = $account->getConsumer();
    if (!$consumer->hasField('personal') || !$consumer->get('personal')->value) {
      return;
    }
    $owner = $consumer->get('user_id')->entity;
    if (!$owner instanceof UserInterface || !$this->manager->isAdminAccount($owner)) {
      return;
    }

    $this->logger->warning('Refused personal API client %label: its owner %owner is an administrator.', [
      '%label' => $consumer->label(),
      '%owner' => $owner->getAccountName(),
    ]);
    throw new AccessDeniedHttpException('This personal API client is disabled because its owner is an administrator.');
  }

}
