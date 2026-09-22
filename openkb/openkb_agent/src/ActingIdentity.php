<?php

declare(strict_types=1);

namespace Drupal\openkb_agent;

use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AccountProxyInterface;
use Drupal\simple_oauth\Authentication\TokenAuthUserInterface;

/**
 * Who the current request acts as, and whether it acts through an agent.
 *
 * The account is always a human one — an agent token is issued against its
 * owner, so `uid` names the person answerable for the write either way. What
 * changes is `via`: the client's label ("Claude") when the request
 * authenticated with an agent token, NULL for an ordinary session.
 *
 * Every surface that has to tell the two apart asks here rather than reaching
 * into simple_oauth itself: the identity endpoint the frontend reads, the
 * presave attribution that credits a block, and the review steps a write
 * stamps ({@see \Drupal\openkb_workflow\PageBlocks::stamp()}). Derived from
 * the authenticated credential on every call, so nothing a caller sends can
 * change the answer.
 */
final class ActingIdentity {

  /**
   * The marking a self-registered client's label carries.
   *
   * Such a client named itself with nobody vouching for it, so every place the
   * label is shown says so. Part of the label rather than a flag, so it reaches
   * the revision log, the contributor list and the presence strip without any
   * of them having to know the distinction exists.
   */
  public const UNVERIFIED_SUFFIX = ' (unverified)';

  /**
   * The scopes that make a token an agent's.
   */
  public const AGENT_SCOPES = ['agent_read', 'agent_write'];

  public function __construct(
    private readonly AccountProxyInterface $currentUser,
  ) {}

  /**
   * The account the request acts as.
   */
  public function uid(): int {
    return (int) $this->currentUser->id();
  }

  /**
   * The account object the request acts as, for permission checks.
   */
  public function account(): AccountInterface {
    return $this->currentUser->getAccount();
  }

  /**
   * The account's display name.
   */
  public function name(): string {
    return $this->currentUser->getAccountName();
  }

  /**
   * The agent label the account acts through, or NULL for a direct request.
   *
   * An agent scope on the token is what makes the request an agent's, whichever
   * client issued it: one provisioned on a profile, one a person connected by
   * URL, or the chat's own (ADR 0015). The client's label is the answer,
   * marking and all. The collaboration server's token carries no agent scope,
   * so it stays a direct request.
   */
  public function via(): ?string {
    $account = $this->currentUser->getAccount();
    if (!$account instanceof TokenAuthUserInterface) {
      return NULL;
    }

    return array_intersect(self::AGENT_SCOPES, $this->scopes()) === []
      ? NULL
      : (string) $account->getConsumer()->label();
  }

  /**
   * Whether this request is an agent's.
   */
  public function isAgent(): bool {
    return $this->via() !== NULL;
  }

  /**
   * The scope ids the request's token was granted; empty for a session.
   *
   * What a token may *do* is never read from here: that is Drupal's own
   * permission and entity-access answer on every request. What the token *is*
   * is read from here — a scope names the client an exchange issued it to,
   * which is how the collaboration server is recognised
   * ({@see \Drupal\openkb_workflow\CollabServerIdentity}) — and a refusal names
   * the ceiling it fell short of.
   *
   * @return string[]
   *   The scope ids.
   */
  public function scopes(): array {
    $account = $this->currentUser->getAccount();
    if (!$account instanceof TokenAuthUserInterface) {
      return [];
    }
    /** @var \Drupal\simple_oauth\Plugin\Field\FieldType\Oauth2ScopeReferenceItemListInterface $field */
    $field = $account->getToken()->get('scopes');
    return array_map(static fn ($scope): string => (string) $scope->id(), $field->getScopes());
  }

}
