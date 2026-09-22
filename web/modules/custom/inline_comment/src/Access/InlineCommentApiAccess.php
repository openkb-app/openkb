<?php

declare(strict_types=1);

namespace Drupal\inline_comment\Access;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\inline_comment\InlineCommentManager;
use Symfony\Component\HttpFoundation\Request;

/**
 * Who the inline-comment endpoint answers, on every verb.
 *
 * Two answers, both required:
 * - `use inline comments api`, the switch that turns the surface off;
 * - the commented entity's own `update` access, which is what decides which
 *   entities. Annotations quote text that is being worked on, so the roster
 *   that may change an entity is the roster that may read and say what is said
 *   about it.
 *
 * It is the route's own access callback rather than the entity's handler
 * because the subject is named by the request, not by the path — see
 * {@see \Drupal\inline_comment\InlineCommentManager::subject()}, which is also
 * where a request naming an entity type this site does not comment on is
 * refused.
 */
final class InlineCommentApiAccess {

  public function __construct(
    private readonly InlineCommentManager $comments,
  ) {}

  /**
   * Whether the account may reach the endpoint for the subject it names.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   * @param \Drupal\Core\Session\AccountInterface $account
   *   The account it authenticates as.
   *
   * @return \Drupal\Core\Access\AccessResultInterface
   *   The access result.
   */
  public function access(Request $request, AccountInterface $account): AccessResultInterface {
    $subject = $this->comments->subject($request);
    return AccessResult::allowedIfHasPermission($account, InlineCommentManager::PERMISSION_USE)
      ->andIf($subject->access('update', $account, TRUE));
  }

}
