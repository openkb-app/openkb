<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow;

use Drupal\Component\Serialization\Json;
use Drupal\openkb_agent\ActingIdentity;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * The collaboration server checkpointing a session, and what it says about it.
 *
 * A checkpoint is the server's own write, over its own OAuth connection (ADR
 * 0001). Its statement says who is acting, whether they asked for the write,
 * and who wrote which part. None of it is a client's to claim: contributorship
 * gates four-eyes sign-off, the acting account is the one the write is
 * performed as, and asking is what lets a wiki space publish. Believed of the
 * collaboration client and of nothing else.
 *
 * Identity, not permission. The client is recognised by the `collab` scope its
 * token carries — the client-credentials-only scope `openkb_recipe_collab`
 * ships and `scripts/setup-collab-oauth.sh` provisions the server's consumer
 * with. A cookie session carries no token and therefore no scope, so a browser
 * save can never take this branch whatever the account behind it may do; an
 * agent's token cannot either, because the scope enables `client_credentials`
 * alone and an agent's is issued by the authorization-code grant.
 * `use collaboration api` stays the access floor the checkpoint's writes answer
 * to — it says what may be written, never who is believed.
 *
 * A statement is also required. The server writes ordinarily too — a seed, a
 * conversation delivery — and reading such a write as a checkpoint that
 * witnessed nobody would open every block it touches unaccounted (ADR 0004).
 */
final class CollabServerIdentity {

  /**
   * The OAuth scope a token carries only where the collaboration client got it.
   */
  public const SCOPE = 'collab';

  /**
   * The most sign-offs one checkpoint may state. See ::actions().
   */
  private const MAX_ACTIONS = 200;

  /**
   * The request the scope was read from, and what it said.
   *
   * @var array{0: \Symfony\Component\HttpFoundation\Request, 1: bool}|null
   */
  private ?array $credential = NULL;

  public function __construct(
    private readonly RequestStack $requestStack,
    private readonly ActingIdentity $identity,
  ) {}

  /**
   * Whether the current request is the collaboration server's checkpoint.
   *
   * @return bool
   *   TRUE when this write is a session checkpoint.
   */
  public function isSessionWrite(): bool {
    return $this->stated() !== NULL && $this->believed();
  }

  /**
   * Whether the request arrived on the collaboration client's connection.
   *
   * Read once per request and kept. The commit route switches the current
   * account to the acting user
   * ({@see \Drupal\openkb_collab_api\Controller\CommitResource}), so reading
   * scopes after that would answer for that user, not for the connection.
   */
  private function believed(): bool {
    $request = $this->requestStack->getCurrentRequest();
    if ($request === NULL) {
      return FALSE;
    }
    if (($this->credential[0] ?? NULL) !== $request) {
      $this->credential = [$request, in_array(self::SCOPE, $this->identity->scopes(), TRUE)];
    }
    return $this->credential[1];
  }

  /**
   * The account the checkpoint says is acting, or NULL where it names none.
   *
   * Named only for somebody who acted: the peer who saved, or the human
   * the window elected where nobody triggered the checkpoint. The write is
   * performed as them, so their own rights decide what it may do
   * ({@see \Drupal\openkb_collab_api\Controller\CommitResource}).
   *
   * @return int|null
   *   The account id, or NULL for a caller that is not the collaboration
   *   client or a statement that names nobody.
   */
  public function actingUid(): ?int {
    $uid = $this->session()['acting_uid'] ?? NULL;
    if (is_int($uid) || (is_string($uid) && ctype_digit($uid))) {
      return (int) $uid > 0 ? (int) $uid : NULL;
    }
    return NULL;
  }

  /**
   * The writer set the checkpoint states for each block it changed (ADR 0002).
   *
   * Exhaustive for the window: the collaboration server adds every writer to
   * each block it changed, so a changed block this does not name is one the
   * session did not witness — see
   * {@see \Drupal\openkb_workflow\PageBlocks::stampSession()}. The
   * statement is membership only (ADR 0002): a `via` entry is an agent member
   * and raises the block's agent step. It carries no amounts.
   *
   * @return array<string, list<array{uid: int, via: string|null}>>
   *   Block id => its writer set. Empty for anything that is not a session
   *   write, whatever the body says.
   */
  public function writers(): array {
    $writers = [];
    foreach ($this->session()['blocks'] ?? [] as $id => $set) {
      // A JSON object key is a string, but a wholly numeric one ("2024") is an
      // int by the time it lands here — and block ids may be numeric.
      $id = is_int($id) ? (string) $id : $id;
      if (!is_string($id) || !is_array($set)) {
        continue;
      }
      foreach ($set as $writer) {
        if (!is_array($writer) || (int) ($writer['uid'] ?? 0) <= 0) {
          continue;
        }
        $via = $writer['via'] ?? NULL;
        $writers[$id][] = [
          'uid' => (int) $writer['uid'],
          'via' => is_string($via) && $via !== '' ? $via : NULL,
        ];
      }
    }
    return $writers;
  }

  /**
   * The sign-offs the checkpoint states, as acts of the peers who made them.
   *
   * A sign-off is not a value in the document — every peer may write that — so
   * the collaboration server records it under the connection it arrived on
   * and states it here with the checkpoint that persists it (ADR 0001/0004).
   * Drupal decides per action whether it may be recorded; see
   * {@see \Drupal\openkb_collab_api\Controller\CommitResource}.
   *
   * `via` names the agent whose seat the connection holds, as on a writer
   * entry. Drupal refuses such a sign-off itself: the gate fails closed on its
   * own side of the wire (ADR 0004).
   *
   * The list is capped: each action costs a user load and an access check
   * under the sidecar lock.
   *
   * @return list<array{item: string, step: string, uid: int, via: string|null}>
   *   The actions stated, in the order the server took them. Empty for
   *   anything that is not a session write, whatever the body says.
   */
  public function actions(): array {
    $actions = [];
    foreach ($this->session()['actions'] ?? [] as $action) {
      if (!is_array($action)) {
        continue;
      }
      $item = $action['item'] ?? NULL;
      $step = $action['step'] ?? NULL;
      $uid = (int) ($action['uid'] ?? 0);
      if (!is_string($item) || $item === '' || $uid <= 0) {
        continue;
      }
      if (!in_array($step, PageBlocks::STEPS, TRUE)) {
        continue;
      }
      $via = $action['via'] ?? NULL;
      $actions[] = [
        'item' => $item,
        'step' => $step,
        'uid' => $uid,
        'via' => is_string($via) && $via !== '' ? $via : NULL,
      ];
      if (count($actions) >= self::MAX_ACTIONS) {
        break;
      }
    }
    return $actions;
  }

  /**
   * The session directives of the current request, believed.
   *
   * @return array
   *   The statement, empty for a caller that is not the collaboration client.
   */
  private function session(): array {
    return $this->isSessionWrite() ? (array) $this->stated() : [];
  }

  /**
   * The `session` member the current request states, or NULL for none.
   *
   * @return array|null
   *   The decoded statement, whoever made it.
   */
  private function stated(): ?array {
    $request = $this->requestStack->getCurrentRequest();
    if (!$request instanceof Request) {
      return NULL;
    }
    $payload = Json::decode((string) $request->getContent());
    $session = is_array($payload) ? ($payload['session'] ?? NULL) : NULL;
    return is_array($session) ? $session : NULL;
  }

}
