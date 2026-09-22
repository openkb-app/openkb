<?php

declare(strict_types=1);

namespace Drupal\openkb_agent_registration\Hook;

use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Hook\Attribute\Hook;
use Drupal\consumers\Entity\ConsumerInterface;

/**
 * The module's hooks.
 */
final class RegistrationHooks {

  /**
   * Implements hook_ENTITY_TYPE_presave() for oauth2_token.
   *
   * A registration is anonymous, so the client it creates starts out owned by
   * nobody — a personal consumer without a user. The first person to authorize
   * it is the one it acts as from then on, so that is who it belongs to: from
   * this point it lists on their profile under "Agent tokens", revocable there,
   * exactly like a token they provisioned by hand.
   *
   * Only an unowned personal consumer is claimed, which is a state nothing but
   * registration creates: a provisioned one has its owner from the start, and a
   * client an administrator added by hand is not personal at all.
   *
   * On presave rather than insert: saving a consumer makes simple_oauth revoke
   * every non-refresh token that consumer has (TokenExpiryTriggerHandler), and
   * an authorization code is one of those. Claiming before the code's row
   * exists leaves it out of that sweep.
   */
  #[Hook('oauth2_token_presave')]
  public function claimConsumer(EntityInterface $token): void {
    if (!$token->isNew() || $token->get('auth_user_id')->isEmpty()) {
      return;
    }
    $consumer = $token->get('client')->entity;
    if (!$consumer instanceof ConsumerInterface
      || !$consumer->hasField('personal')
      || !$consumer->get('personal')->value
      || !$consumer->get('user_id')->isEmpty()) {
      return;
    }
    $consumer->set('user_id', $token->get('auth_user_id')->target_id);
    $consumer->save();
  }

}
