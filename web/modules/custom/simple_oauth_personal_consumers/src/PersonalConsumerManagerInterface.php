<?php

declare(strict_types=1);

namespace Drupal\simple_oauth_personal_consumers;

use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\user\UserInterface;

/**
 * Provisions, revokes and sweeps owner-bound personal OAuth2 consumers.
 */
interface PersonalConsumerManagerInterface {

  /**
   * Creates a personal client-credentials consumer bound to the owner.
   *
   * Tokens issued for the consumer authenticate as the owner, capped by the
   * scopes configured in simple_oauth_personal_consumers.settings: the
   * effective permissions are always owner ∩ scope, computed live per
   * request.
   *
   * @param \Drupal\user\UserInterface $owner
   *   The account the consumer acts for.
   * @param string $label
   *   Human-readable client label, e.g. "Claude".
   *
   * @return \Drupal\simple_oauth_personal_consumers\PersonalConsumerCredentials
   *   The consumer with its one-time plaintext client secret.
   *
   * @throws \InvalidArgumentException
   *   If the owner is the anonymous user or an administrator account (see
   *   ::isAdminAccount()).
   */
  public function create(UserInterface $owner, string $label): PersonalConsumerCredentials;

  /**
   * Whether the account may not own personal consumers because it is an admin.
   *
   * A token acts as its owner, and simple_oauth passes an admin owner's
   * bypass through to the token: an admin-owned client would ignore its
   * scope ceiling entirely. Administrator accounts are therefore refused;
   * agents run on non-admin accounts. The super-user (uid 1) counts as an
   * administrator regardless of its roles.
   *
   * @param \Drupal\user\UserInterface $owner
   *   The account to check.
   *
   * @return bool
   *   TRUE if the account holds an admin role or is the super-user.
   */
  public function isAdminAccount(UserInterface $owner): bool;

  /**
   * Revokes a personal consumer: tokens die, issuance stops, entity stays.
   *
   * The consumer entity is kept (disabled) so historical attribution to it
   * keeps resolving.
   *
   * @param \Drupal\consumers\Entity\ConsumerInterface $consumer
   *   The personal consumer.
   */
  public function revoke(ConsumerInterface $consumer): void;

  /**
   * Returns the personal consumers owned by the given account.
   *
   * @param \Drupal\user\UserInterface $owner
   *   The owner account.
   *
   * @return \Drupal\consumers\Entity\ConsumerInterface[]
   *   Personal consumers keyed by id, revoked ones included.
   */
  public function getConsumers(UserInterface $owner): array;

  /**
   * Whether the owner already has a client under this name.
   *
   * A name is how every page names the agent, and it is half the key work is
   * assigned by ({@see \Drupal\openkb_agent\ActingIdentity::via()}) — two of
   * one person's agents under one name would each answer the other's
   * assignments. Compared case-insensitively on the trimmed label, across the
   * owner's clients, revoked ones included: a revoked client keeps its name on
   * the api-clients page and in everything it wrote.
   *
   * Per owner, so two people may each name their agent "claude".
   *
   * @param \Drupal\user\UserInterface $owner
   *   The owner account.
   * @param string $name
   *   The name to take.
   * @param \Drupal\consumers\Entity\ConsumerInterface|null $except
   *   A client that may hold the name — the one being renamed.
   *
   * @return bool
   *   TRUE if another of the owner's clients holds the name.
   */
  public function nameTaken(UserInterface $owner, string $name, ?ConsumerInterface $except = NULL): bool;

  /**
   * What to say about a name the owner's clients already hold.
   *
   * One wording for every form that sets a name.
   *
   * @param string $name
   *   The name that is taken.
   *
   * @return \Drupal\Core\StringTranslation\TranslatableMarkup
   *   The error to show on the name field.
   */
  public function nameTakenError(string $name): TranslatableMarkup;

  /**
   * Stamps the consumer's `last_used` with now, at most once an hour.
   *
   * The stamp answers "is this client still in use", which an hour resolves
   * fine — one write per consumer per hour instead of one per token request.
   *
   * @param \Drupal\consumers\Entity\ConsumerInterface $consumer
   *   The consumer a token was just issued for.
   */
  public function recordUsage(ConsumerInterface $consumer): void;

  /**
   * Deletes personal consumers nobody ever claimed, past their retention.
   *
   * Self-registration (RFC 7591) creates a personal consumer owned by nobody;
   * the first person to authorize it becomes its owner. One that is never
   * authorized stays ownerless and useless, so it is deleted once it is older
   * than `simple_oauth_personal_consumers.settings:unclaimed_retention`.
   *
   * @return int
   *   The number of consumers deleted.
   */
  public function sweepUnclaimed(): int;

  /**
   * Whether the consumer is a revoked personal consumer.
   *
   * @param \Drupal\consumers\Entity\ConsumerInterface $consumer
   *   The consumer.
   *
   * @return bool
   *   TRUE if the consumer has been revoked.
   */
  public function isRevoked(ConsumerInterface $consumer): bool;

}
