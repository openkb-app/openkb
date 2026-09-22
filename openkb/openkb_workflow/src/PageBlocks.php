<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow;

use Drupal\Component\Serialization\Json;

/**
 * The page seen as the blocks it is made of, and the review state of each.
 *
 * One service holds the block model on the Drupal side: how markdown divides
 * into blocks, what changed between two revisions of it, and what the review
 * sidecar (`field_block_meta`) says about a block. Everything that needs any
 * of that — presave attribution, the commit endpoint and the publish gate —
 * injects `openkb_workflow.page_blocks` and asks it rather than reading the
 * JSON itself, so the key names and the rules exist once.
 *
 * The read page does not come through here: the CE display ships the stored
 * sidecar as it stands and the frontend derives the byline from it, against
 * the same key names.
 *
 * It holds no state and reads no other service: every method answers from its
 * arguments alone. It is a service so that the things it serves can be built,
 * and tested, against a container rather than against a class name.
 *
 * The frontend mirrors the model in `frontend/shared/page-blocks.ts`; the
 * two agree on the key names because they read and write the same stored JSON.
 * Nothing else is shared: this side never parses markdown into a tree.
 *
 * ## The sidecar
 *
 * `field_block_meta` is a JSON object keyed by block id. Per block:
 *
 * @code
 * {
 *   "contributors": [{"uid": 3, "via": null, "name": "fago", "lastEdit": 1754…}],
 *   "pending:peer":  {"by": [3, 7], "ok": [{"uid": 7, …}]},
 *   "pending:agent": {"by": [9], "ok": []},
 *   "review:peer":   {"uid": 7, "name": "ada", "at": 1754…, "vid": 21}
 * }
 * @endcode
 *
 * A `pending:<step>` key present IS the pending flag — there is nothing to
 * derive and no fingerprint to compare. `by` are the accounts that changed the
 * block since the step was last satisfied (its four-eyes baseline), `ok` the
 * approvals recorded against that same episode. Satisfying a step deletes the
 * key and records the sign-off under `review:<step>`, which is byline data and
 * gates nothing.
 *
 * Two entries stand for something other than a block the body holds, and carry
 * the same keys as any other:
 *
 * - A **removed block** keeps its entry, marked `"deleted": true`. Its text is
 *   gone from the body, so the entry is all a reviewer can be shown.
 * - A **reviewed field** takes a `field:`-prefixed key of its own —
 *   `field:title`. A block id is `[\w-]+`, so the colon keeps a field's entry
 *   out of reach of any id a body could carry.
 *
 * A **moved block** is an ordinary entry marked `"moved": true`: its text is
 * in the document and unchanged, so the flag is what names the difference.
 *
 * That is the whole of the model's answer to "which changes are reviewed":
 * every difference between a draft and the published revision has an entry
 * here, so none of them can reach the live page without one (ADR 0017).
 *
 * ## Nobody but Drupal writes it
 *
 * Every value here is witnessed by the server that wrote it: a contributor
 * record comes from diffing what a request actually changed, an approval from
 * the account that authenticated. The field is write-dead to clients on every
 * path (see openkb_workflow_entity_field_access() and
 * \Drupal\openkb_collab_api\Controller\CommitResource), so no caller can hand
 * in a cleared flag or an approval it did not earn.
 */
final class PageBlocks {

  /**
   * The peer step: a human other than the author has to sign the change off.
   */
  public const STEP_PEER = 'peer';

  /**
   * The agent step: a human has to sign off what an agent wrote.
   */
  public const STEP_AGENT = 'agent';

  /**
   * Both steps, in the order a blocker list names them.
   */
  public const STEPS = [self::STEP_PEER, self::STEP_AGENT];

  /**
   * Prefix of a review entry keyed by a node field rather than by a block.
   *
   * A block id is `[\w-]+`, so the colon keeps the two namespaces apart: no
   * body can carry a block whose id collides with a field's entry.
   */
  private const FIELD_PREFIX = 'field:';

  /**
   * The entry the page's title is reviewed under.
   */
  public const FIELD_TITLE = self::FIELD_PREFIX . 'title';

  /**
   * Marks an entry whose block the body no longer holds.
   */
  private const DELETED = 'deleted';

  /**
   * Marks an entry whose block the draft holds in a different place.
   */
  private const MOVED = 'moved';

  /**
   * Prefix of the key that carries a step's pending flag.
   */
  private const PENDING_PREFIX = 'pending:';

  /**
   * Prefix of the key that carries a step's latest completed sign-off.
   */
  private const REVIEW_PREFIX = 'review:';

  /**
   * Hex characters of the sha256 a block version carries.
   */
  private const VERSION_LENGTH = 12;

  /**
   * A trailing `{#id}` on a text block — the id comark round-trips.
   */
  private const TRAILING_ID = '/\{#([\w-]+)\}\s*$/';

  /**
   * The `#id` shorthand closing a component fence's prop list.
   */
  private const FENCE_ID = '/#([\w-]+)\}\s*$/';

  /**
   * The leading `# <title>` line and the blank lines under it.
   *
   * The page title is a node field, so its line in the stored body is that
   * field's spelling in markdown, not a block. The frontend splits it off at
   * the read boundary and joins it back on at every write
   * (`frontend/server/utils/title-heading.ts`); this side reads it the same
   * way, so it is never attributed, reviewed or held against a publish.
   */
  private const TITLE_HEADING = '/^#[ \t][^\n]*\n?(?:[ \t]*\n)*/';

  // ---------------------------------------------------------------------
  // Markdown → blocks
  // ---------------------------------------------------------------------

  /**
   * The identified blocks of a body, as block id => raw segment.
   *
   * Segments are compared, never parsed: two revisions agree on a block when
   * the bytes between its boundaries are identical. That is why this needs no
   * markdown engine and cannot drift from the editor's own serializer — the
   * only syntax it knows is where a block ends and where its id sits.
   *
   * Blocks carrying no id are left out. They are unaddressable: nothing can
   * flag them, approve them or name them in a blocker list, and the editor
   * mints an id into every block it touches.
   *
   * @param string $markdown
   *   The body.
   *
   * @return array<string, string>
   *   Block id => the block's raw markdown, in document order.
   */
  public function segment(string $markdown): array {
    $blocks = [];
    foreach ($this->chunks($markdown) as $chunk) {
      $id = $this->idOf($chunk);
      if ($id !== NULL) {
        $blocks[$id] = $chunk;
      }
    }
    return $blocks;
  }

  /**
   * A block's version — the short content hash of its own markdown.
   *
   * The same string the frontend's `blockVersion()` answers for the same
   * segment (`frontend/server/utils/block-versions.ts`): both hash the bytes
   * between a block's boundaries and keep the first characters of the digest.
   * A citation stores the version it was made against, so a citation written
   * in the editor and one read back here have to compare equal.
   *
   * @param string $segment
   *   The block's markdown, as {@see self::segment()} cuts it.
   *
   * @return string
   *   The version.
   */
  public function version(string $segment): string {
    return substr(hash('sha256', $segment), 0, self::VERSION_LENGTH);
  }

  /**
   * Block id => version, for every addressable block of a body.
   *
   * @param string $markdown
   *   The body.
   *
   * @return array<string, string>
   *   Block id => the block's version, in document order.
   */
  public function versions(string $markdown): array {
    return array_map($this->version(...), $this->segment($markdown));
  }

  /**
   * The ids of the blocks one write changed.
   *
   * A block counts as changed when its bytes moved, when it is new, or when it
   * kept its bytes and took a different place in the document: reordering is a
   * change to what the page says, so it owes a review like any other.
   *
   * @param string $new
   *   The body being written.
   * @param string $old
   *   The body of the revision it is written on top of.
   *
   * @return list<string>
   *   The changed blocks' ids.
   */
  public function changed(string $new, string $old): array {
    $before = $this->segment($old);
    $after = $this->segment($new);
    $in_place = $this->inOrder(array_keys($before), array_keys($after));
    $changed = [];
    foreach ($after as $id => $segment) {
      if (($before[$id] ?? NULL) !== $segment || !isset($in_place[$id])) {
        $changed[] = $id;
      }
    }
    return $changed;
  }

  /**
   * The ids of the blocks one write only put in a different place.
   *
   * The bytes are the ones the revision already held; what moved is where the
   * page says them. A collaborative session books writing, so it witnesses no
   * writer for such a block and the account that saved the move is the one
   * answerable for it ({@see \Drupal\openkb_workflow\BlockAttribution}).
   *
   * @param string $new
   *   The body being written.
   * @param string $old
   *   The body of the revision it is written on top of.
   *
   * @return list<string>
   *   The ids of the blocks that moved and nothing else.
   */
  public function moved(string $new, string $old): array {
    $before = $this->segment($old);
    $after = $this->segment($new);
    $in_place = $this->inOrder(array_keys($before), array_keys($after));
    $moved = [];
    foreach ($after as $id => $segment) {
      if (!isset($in_place[$id]) && ($before[$id] ?? NULL) === $segment) {
        $moved[] = $id;
      }
    }
    return $moved;
  }

  /**
   * The ids of the blocks one write took out of the body.
   *
   * A deletion is a change nothing else in this model can see: the block is
   * gone from the text the diff walks, so it is named here or not at all.
   *
   * @param string $new
   *   The body being written.
   * @param string $old
   *   The body of the revision it is written on top of.
   *
   * @return list<string>
   *   The removed blocks' ids.
   */
  public function removed(string $new, string $old): array {
    return array_values(array_diff(
      array_keys($this->segment($old)),
      array_keys($this->segment($new)),
    ));
  }

  // ---------------------------------------------------------------------
  // Sidecar codec
  // ---------------------------------------------------------------------

  /**
   * The sidecar as an array; anything unreadable decodes to no blocks.
   *
   * @param string|null $json
   *   The stored field value.
   *
   * @return array<string, array>
   *   Block id => the block's sidecar entry.
   */
  public function decode(?string $json): array {
    if ($json === NULL || trim($json) === '') {
      return [];
    }
    $decoded = Json::decode($json);
    return is_array($decoded) ? array_filter($decoded, 'is_array') : [];
  }

  /**
   * The sidecar as it is stored, sorted by block id.
   *
   * A page with no review history encodes to the empty string, so it
   * stores no value at all rather than an empty object.
   *
   * @param array<string, array> $blocks
   *   Block id => the block's sidecar entry.
   *
   * @return string
   *   The field value.
   */
  public function encode(array $blocks): string {
    $blocks = array_filter($blocks);
    if ($blocks === []) {
      return '';
    }
    ksort($blocks);
    return Json::encode($blocks);
  }

  // ---------------------------------------------------------------------
  // Per-block state
  // ---------------------------------------------------------------------

  /**
   * The block after `$uid` changed it — attributed, and both steps re-stamped.
   *
   * Re-stamping drops the approvals already collected on the step: they were
   * given to text that has since moved, and an approval that survives the edit
   * it was meant to cover is exactly the endorsement nobody made. The four-eyes
   * baseline (`by`) grows instead, so a second author on the same episode
   * enables the mutual path.
   *
   * The agent step is stamped only for an agent credential — that is what it
   * tracks — while the peer step is stamped for every writer alike.
   *
   * @param array $block
   *   The block's sidecar entry, empty when it has none yet.
   * @param int $uid
   *   The account that wrote.
   * @param string|null $via
   *   The agent label the account acted through, NULL for a direct write.
   * @param string|null $name
   *   The account's display name, for the byline.
   * @param int $at
   *   The write's timestamp.
   *
   * @return array
   *   The block's new sidecar entry.
   */
  public function stamp(array $block, int $uid, ?string $via, ?string $name, int $at): array {
    $block = $this->addContribution($block, $uid, $via, $name, $at);
    $block = $this->markPending($block, self::STEP_PEER, [$uid]);
    return $via === NULL ? $block : $this->markPending($block, self::STEP_AGENT, [$uid]);
  }

  /**
   * The entry marked as standing for a block the body no longer holds.
   *
   * The entry outlives its block on purpose: a deletion is the one change that
   * leaves no text to hang a flag on, so the record of it is the only thing a
   * reviewer can be shown and the only thing the gate can hold. It is retired
   * once the live page has stopped showing the block too
   * ({@see \Drupal\openkb_workflow\BlockAttribution::reviewItems()}).
   *
   * @param array $block
   *   The block's sidecar entry.
   *
   * @return array
   *   The entry, marked deleted.
   */
  public function markDeleted(array $block): array {
    $block[self::DELETED] = TRUE;
    unset($block[self::MOVED]);
    return $block;
  }

  /**
   * The entry marked as standing for a block the body holds again.
   *
   * A block put back is an ordinary block: the flag has to come off or the
   * reader is shown a removed-block card for text that is in the document.
   *
   * @param array $block
   *   The block's sidecar entry.
   *
   * @return array
   *   The entry, no longer marked deleted.
   */
  public function markPresent(array $block): array {
    unset($block[self::DELETED], $block[self::MOVED]);
    return $block;
  }

  /**
   * The entry marked as standing for a block the draft says in another place.
   *
   * The block's text is in the document and reads like any other, so the flag
   * is what tells a reviewer which difference they are being asked to judge.
   * Recomputed against the live page on every write, as the deleted flag is.
   *
   * @param array $block
   *   The block's sidecar entry.
   *
   * @return array
   *   The entry, marked moved.
   */
  public function markMoved(array $block): array {
    $block[self::MOVED] = TRUE;
    unset($block[self::DELETED]);
    return $block;
  }

  /**
   * The entry after a checkpoint changed something the body does not hold.
   *
   * A removal and a reviewed field have no text for a later edit to re-stamp,
   * so a baseline naming nobody would hold the page for good. A window that
   * names no writer therefore falls back to the accounts the entry records a
   * contribution for, which always hold whoever wrote what is being removed or
   * replaced. An entry recording nobody keeps the empty baseline (ADR 0004).
   *
   * @param array $block
   *   The entry, empty when there is none yet.
   * @param list<array{uid: int, via: string|null, name: string|null}> $writers
   *   The item's writer set in this window.
   * @param int $at
   *   The write's timestamp.
   *
   * @return array
   *   The item's new sidecar entry.
   */
  public function stampItem(array $block, array $writers, int $at): array {
    if ($writers !== []) {
      return $this->stampSession($block, $writers, $at);
    }
    $uids = array_map(
      static fn (array $contributor): int => (int) $contributor['uid'],
      $this->contributors($block),
    );
    return $uids === []
      ? $this->markUnaccounted($block, self::STEP_PEER)
      : $this->markPending($block, self::STEP_PEER, array_values(array_unique($uids)));
  }

  /**
   * The block after a collaborative session's checkpoint changed it.
   *
   * A checkpoint is one request carrying several peers' writing, so the writer
   * Drupal authenticated is not the answer to "who wrote this" — it is
   * whichever peer connected last. The collaboration server witnessed the
   * keystrokes and states the whole window in the same request as the text
   * ({@see \Drupal\openkb_workflow\CollabServerIdentity}), so all of it is
   * recorded here, in the save that writes the text it describes: every named
   * account is recorded a contributor and joins the episode's four-eyes
   * baseline. The statement is membership only (ADR 0002): it carries no
   * amounts, and neither does the sidecar.
   *
   * A block this write changed that the window names nobody for is not one of
   * the session's peers' work at all — the collaboration server books every
   * block whose content moves, so what it does not name is writing it never
   * witnessed: text left in a document by a window whose accounting was lost
   * before any write carried it. (A block only put in another place moves no
   * content, so its writer is named by the caller instead
   * ({@see \Drupal\openkb_workflow\BlockAttribution}).) Its episode is
   * opened naming NOBODY, and an episode with an empty baseline is approvable
   * by nobody ({@see self::mayApprove()}) until an identified edit re-stamps
   * it: the four-eyes baseline may only carry names this server witnessed, or
   * the writing's real author clears it as an outsider.
   *
   * That stamp *replaces* the episode rather than joining it — the one place in
   * this model where a baseline does not grow. The baseline has to exclude
   * whoever wrote the arriving text, and the names an earlier episode carries
   * are no answer to who that is, so the names go with the approvals and the
   * block is back to approvable by nobody until an identified edit re-stamps
   * it.
   *
   * Agents are session peers now (ADR 0003): a writer carrying a `via` label is
   * an agent member, and its presence raises the agent step — so agent-written
   * text still needs a human sign-off, and the requirement travels in the set
   * rather than on the checkpoint's credential. A human-only window touches the
   * peer step only, so a standing agent step survives a human's rework.
   *
   * @param array $block
   *   The block's sidecar entry, empty when it has none yet.
   * @param list<array{uid: int, via: string|null, name: string|null}> $writers
   *   The block's writer set in this window.
   * @param int $at
   *   The write's timestamp.
   *
   * @return array
   *   The block's new sidecar entry.
   */
  public function stampSession(array $block, array $writers, int $at): array {
    if ($writers === []) {
      return $this->markUnaccounted($block, self::STEP_PEER);
    }
    $uids = [];
    $agent_uids = [];
    foreach ($writers as $writer) {
      $block = $this->addContribution($block, (int) $writer['uid'], $writer['via'], $writer['name'], $at);
      $uids[] = (int) $writer['uid'];
      if (($writer['via'] ?? NULL) !== NULL) {
        $agent_uids[] = (int) $writer['uid'];
      }
    }
    $block = $this->markPending($block, self::STEP_PEER, $uids);
    return $agent_uids === [] ? $block : $this->markPending($block, self::STEP_AGENT, $agent_uids);
  }

  /**
   * The block after a checkpoint carried a window naming it, unchanged.
   *
   * A window is owed until a write carries it, and by then another path may
   * already hold the very text it accounts for — an agent committing the shared
   * document under its own token, or this session's own PATCH whose response
   * was lost on the way back. Either way the bytes are unchanged and the peers
   * who typed them still have to reach the block's four-eyes baseline, or each
   * of them is an outsider to their own paragraph.
   *
   * What separates this from {@see self::stampSession()} is what it does NOT
   * do, and both halves matter:
   *
   *   - **The approvals stand.** A sign-off covers the text it was given to,
   *     and this write did not move that text. Dropping it would void a review
   *     nothing invalidated — and on a window re-delivered after a lost
   *     response it would do so on every attempt.
   *   - **No characters are credited.** They belong to the write that put the
   *     bytes there and are already booked to whoever carried it; adding them
   *     again counts the same writing twice, which is exactly what a
   *     re-delivered window would do. The peers are recorded as having touched
   *     the block — which is what the four-eyes rule reads — at no characters.
   *
   * One sign-off does not stand: the one given by somebody this window names.
   * A step already satisfied was judged against a baseline that did not know
   * these peers wrote the block, and the account that cleared it counted as an
   * outsider on exactly that basis. Now that it names them, the step reopens
   * and asks for eyes that did not write it. A step still open is only widened,
   * because nothing has been cleared against the old baseline yet; a step
   * cleared by anybody else is a review of text this write left alone, and
   * stands. A block with no review state at all opens its first episode here.
   *
   * The agent step is only widened, never re-opened, on a carry: a via member
   * a pending agent step does not yet name is added to it, but a settled or
   * absent one is left alone — the text this write carried was already reviewed
   * as it stands (or its agent write landed under its own token elsewhere).
   *
   * @param array $block
   *   The block's sidecar entry, empty when it has none yet.
   * @param list<array{uid: int, via: string|null, name: string|null}> $writers
   *   The block's writer set as the window names it.
   * @param int $at
   *   The write's timestamp.
   *
   * @return array
   *   The block's new sidecar entry.
   */
  public function carrySession(array $block, array $writers, int $at): array {
    $uids = [];
    $agent_uids = [];
    foreach ($writers as $writer) {
      $block = $this->addContribution($block, (int) $writer['uid'], $writer['via'], $writer['name'], $at);
      $uids[] = (int) $writer['uid'];
      if (($writer['via'] ?? NULL) !== NULL) {
        $agent_uids[] = (int) $writer['uid'];
      }
    }
    if ($agent_uids !== [] && $this->isPending($block, self::STEP_AGENT)) {
      $block = $this->widenPending($block, self::STEP_AGENT, $agent_uids);
    }
    if ($this->isPending($block, self::STEP_PEER)) {
      return $this->widenPending($block, self::STEP_PEER, $uids);
    }
    $settled = $block[self::REVIEW_PREFIX . self::STEP_PEER] ?? NULL;
    $signer = $settled['uid'] ?? NULL;
    if ($signer !== NULL && !in_array((int) $signer, $uids, TRUE)) {
      return $block;
    }
    // Re-opening a settled step restores the baseline it settled and adds this
    // window's writers to it. Seeding from the window alone would drop everyone
    // the step was already waiting on — the account that wrote the bulk of the
    // block, most of all — and hand them a step they could then clear alone.
    //
    // A record that does not carry one cannot say what it settled, and the one
    // thing this may not do is answer "nobody": every account the block records
    // a contribution for is then the baseline. It is the wider answer of the
    // two — a step is only ever harder to satisfy for it — and it always holds
    // the account that wrote the block, which is the account the four-eyes rule
    // exists to keep out.
    $prior = $this->settledBaseline($block, $settled);
    return $this->markPending($block, self::STEP_PEER, array_values(array_unique(array_merge($prior, $uids))));
  }

  /**
   * The block after `$uid` approved one of its steps.
   *
   * Records the approval against the current episode, then settles the step:
   * satisfied, the flag goes and the sign-off is kept for the byline; not yet,
   * the approval waits for the co-author who still owes one.
   *
   * Callers must have asked {@see self::mayApprove()} first — this records
   * what it is given.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step being approved.
   * @param int $uid
   *   The approving account.
   * @param string|null $name
   *   The approver's display name, for the byline.
   * @param int $at
   *   The approval's timestamp.
   * @param int $vid
   *   The revision the approval was given against.
   * @param bool $is_admin
   *   Whether the approver may self-approve (the ADR 0002 admin exception).
   *
   * @return array
   *   The block's new sidecar entry.
   */
  public function approve(array $block, string $step, int $uid, ?string $name, int $at, int $vid, bool $is_admin = FALSE): array {
    $pending = $this->pendingEntry($block, $step);
    if ($pending === NULL) {
      return $block;
    }

    $record = ['uid' => $uid, 'name' => $name, 'at' => $at, 'vid' => $vid];
    $pending['ok'] = array_values(array_filter(
      $pending['ok'],
      static fn (array $ok): bool => (int) $ok['uid'] !== $uid,
    ));
    $pending['ok'][] = $record;

    // An admin's approval settles outright (ADR 0002): mayApprove() admitted
    // them past the membership rule, so satisfies() — which only knows the
    // stored uids — must not un-decide it.
    if (!$is_admin && !$this->satisfies($step, $pending)) {
      $block[self::PENDING_PREFIX . $step] = $pending;
      return $block;
    }

    unset($block[self::PENDING_PREFIX . $step]);
    // The settled record carries the baseline it settled. Unsetting the pending
    // entry is the only place this model forgets who wrote a block, and a step
    // re-opened over the same text ({@see self::carrySession()}) has to ask for
    // eyes that did not write it — all of them, not only the ones the write
    // re-opening it happens to name.
    $block[self::REVIEW_PREFIX . $step] = $record + ['by' => $pending['by']];
    return $block;
  }

  /**
   * Whether a step of this block is waiting for review.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step.
   *
   * @return bool
   *   TRUE while the step is pending.
   */
  public function isPending(array $block, string $step): bool {
    return $this->pendingEntry($block, $step) !== NULL;
  }

  /**
   * Whether `$uid` may approve a step of this block — the four-eyes rule.
   *
   * A change is signed off by somebody who did not make it. Where two or more
   * accounts share the episode, each of them approving the others' work
   * satisfies that as well: every contributor has then had their work seen by
   * another pair of eyes, which is the property the rule protects. What it
   * never allows is the sole author of a change approving it alone.
   *
   * The agent step is not a four-eyes step — it asks for a human, not for a
   * second one — so any human approver may clear it.
   *
   * An episode naming NOBODY is refused outright — for everybody, its own
   * carrier included. That is a state the model produces deliberately: it is
   * how a block changed by writing no server could attribute is marked
   * ({@see self::stampSession()}). "Whoever wrote this may not sign it off"
   * cannot be applied against a baseline that does not say who wrote it, and
   * answering TRUE there hands the writing's real author exactly the approval
   * the rule exists to withhold. Such a block holds up a publication until an
   * identified edit re-stamps it, at which point the episode names a real
   * writer and a second pair of eyes can clear it.
   *
   * `$is_admin` is the ADR 0002 exception: an admin may self-approve, and
   * approve an episode naming nobody — the review is still recorded, never
   * skipped. The caller decides who is an admin (see
   * {@see \Drupal\openkb_workflow\ReviewPolicy::mayModerate()}).
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step being approved.
   * @param int $uid
   *   The approving account.
   * @param bool $is_admin
   *   Whether the account may moderate this page past the four-eyes rule.
   *
   * @return bool
   *   TRUE when the approval may be recorded.
   */
  public function mayApprove(array $block, string $step, int $uid, bool $is_admin = FALSE): bool {
    $pending = $this->pendingEntry($block, $step);
    if ($pending === NULL) {
      return FALSE;
    }
    if ($step === self::STEP_AGENT || $is_admin) {
      return TRUE;
    }
    return $pending['by'] !== [] && $pending['by'] !== [$uid];
  }

  /**
   * The accounts whose changes this step is still waiting on.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step.
   *
   * @return int[]
   *   The account ids, in first-contribution order.
   */
  public function contributorsSince(array $block, string $step): array {
    return $this->pendingEntry($block, $step)['by'] ?? [];
  }

  /**
   * Why the rule turns a sign-off down, in the words the reviewer is shown.
   *
   * Two sentences, because the two refusals ask for different things: one more
   * pair of eyes, or one more edit. A block whose baseline names nobody is
   * waiting on writing no server could attribute
   * ({@see self::stampSession()}).
   *
   * Asked only of a step {@see self::mayApprove()} refused.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step that was refused.
   * @param string $id
   *   The review item's key, as the sentence names it.
   *
   * @return string
   *   The sentence.
   */
  public function refusalReason(array $block, string $step, string $id): string {
    return sprintf(
      $this->contributorsSince($block, $step) === []
        ? '%s needs an identified edit before anybody can sign it off: nothing on record says who wrote it.'
        : '%s needs a second pair of eyes: its only contributor is the account approving it.',
      self::itemName($id),
    );
  }

  /**
   * How a sentence names one review item at its start.
   *
   * A field's entry is not a block and saying "Block field:title" of it would
   * name something the reader cannot find.
   *
   * @param string $id
   *   The review item's key.
   *
   * @return string
   *   The item's name.
   */
  public static function itemName(string $id): string {
    return $id === self::FIELD_TITLE ? 'The page title' : sprintf('Block %s', $id);
  }

  // ---------------------------------------------------------------------
  // Whole-page passes
  // ---------------------------------------------------------------------

  /**
   * The review items holding up a publication, as key => the steps they owe.
   *
   * Every entry the sidecar carries is asked alike — a block, a removed block's
   * record, a reviewed field — so no kind of change is exempt (ADR 0017).
   *
   * Only the steps the page's space enforces are asked about — an unenforced
   * flag is still recorded, so turning the policy on later finds the history
   * already there.
   *
   * @param array<string, array> $blocks
   *   The decoded sidecar.
   * @param string[] $steps
   *   The enforced steps.
   *
   * @return array<string, string[]>
   *   Review item => the steps it is pending on, for the items that have any.
   */
  public function blockers(array $blocks, array $steps): array {
    $blockers = [];
    foreach ($blocks as $id => $block) {
      $owed = array_values(array_filter($steps, fn (string $step): bool => $this->isPending($block, $step)));
      // An unaccounted change — a pending step naming no writer — blocks in
      // every space, enforced steps or none: nobody witnessed the writing, so
      // nobody may wave it through by policy (ADR 0004). Healed by an
      // identified edit, or approved by an admin.
      foreach (array_keys($block) as $key) {
        if (!str_starts_with((string) $key, self::PENDING_PREFIX)) {
          continue;
        }
        $step = substr((string) $key, strlen(self::PENDING_PREFIX));
        $entry = $this->pendingEntry($block, $step);
        if ($entry !== NULL && $entry['by'] === [] && !in_array($step, $owed, TRUE)) {
          $owed[] = $step;
        }
      }
      if ($owed !== []) {
        $blockers[$id] = $owed;
      }
    }
    ksort($blockers);
    return $blockers;
  }

  /**
   * The body's text OUTSIDE identified blocks.
   *
   * An id-less block cannot be flagged, approved or credited, so a non-empty
   * remainder refuses publication outright (the gate's structural check) and
   * a change to one still counts as a content change — stripping ids must not
   * become a review bypass. The concatenated un-identified text answers both.
   */
  public function unaddressed(string $markdown): string {
    $rest = [];
    foreach ($this->chunks($markdown) as $chunk) {
      if ($this->idOf($chunk) === NULL) {
        $rest[] = $chunk;
      }
    }
    return implode("\n\n", $rest);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * The body's top-level chunks, blank-line separated.
   *
   * Blank lines inside a component fence or a code fence do not separate
   * anything — the block continues — so both are tracked while splitting.
   *
   * The title heading (self::TITLE_HEADING) is not among them: it belongs to
   * the title field, so neither segment() nor unaddressed() ever sees it.
   *
   * @param string $markdown
   *   The body.
   *
   * @return string[]
   *   The chunks, trimmed of surrounding blank lines, empties dropped.
   */
  private function chunks(string $markdown): array {
    $markdown = preg_replace(self::TITLE_HEADING, '', $markdown) ?? $markdown;
    $chunks = [];
    $current = [];
    $fences = [];
    $code = FALSE;

    foreach (preg_split('/\R/', $markdown) ?: [] as $line) {
      if (preg_match('/^\s*```/', $line)) {
        $code = !$code;
      }
      elseif (!$code && preg_match('/^(:{2,})(\S+)?/', $line, $match)) {
        // A colon run with a name opens a fence; a bare one closes the
        // innermost fence opened with the same run length.
        if (($match[2] ?? '') !== '') {
          $fences[] = strlen($match[1]);
        }
        elseif ($fences !== [] && end($fences) === strlen($match[1])) {
          array_pop($fences);
        }
      }

      if (trim($line) === '' && !$code && $fences === []) {
        $chunks[] = $current;
        $current = [];
        continue;
      }
      $current[] = $line;
    }
    $chunks[] = $current;

    return array_values(array_filter(array_map(
      static fn (array $lines): string => trim(implode("\n", $lines)),
      $chunks,
    )));
  }

  /**
   * The block id a chunk carries, or NULL when it bears none.
   *
   * A text block carries it as trailing `{#id}`; a component fence as the
   * `#id` shorthand closing its prop list.
   *
   * @param string $chunk
   *   The chunk.
   *
   * @return string|null
   *   The block id.
   */
  private function idOf(string $chunk): ?string {
    if (preg_match(self::TRAILING_ID, $chunk, $match)) {
      return $match[1];
    }
    $first = strtok($chunk, "\n");
    if (str_starts_with($chunk, '::') && preg_match(self::FENCE_ID, (string) $first, $match)) {
      return $match[1];
    }
    return NULL;
  }

  /**
   * The ids that hold their place between two orderings, as a set.
   *
   * The longest common subsequence of the two id sequences. A block outside it
   * is one the document moved: the blocks around it kept their order and it did
   * not. An insertion at the top therefore moves nothing below it, and re-opens
   * no block it did not touch.
   *
   * @param list<string> $old
   *   The block ids of the revision written on top of, in document order.
   * @param list<string> $new
   *   The block ids of the body being written, in document order.
   *
   * @return array<string, true>
   *   The ids that did not move.
   */
  private function inOrder(array $old, array $new): array {
    $rows = count($old);
    $cols = count($new);
    $length = array_fill(0, $rows + 1, array_fill(0, $cols + 1, 0));
    for ($i = 1; $i <= $rows; $i++) {
      for ($j = 1; $j <= $cols; $j++) {
        $length[$i][$j] = $old[$i - 1] === $new[$j - 1]
          ? $length[$i - 1][$j - 1] + 1
          : max($length[$i - 1][$j], $length[$i][$j - 1]);
      }
    }

    $kept = [];
    $i = $rows;
    $j = $cols;
    while ($i > 0 && $j > 0) {
      if ($old[$i - 1] === $new[$j - 1]) {
        $kept[$old[$i - 1]] = TRUE;
        $i--;
        $j--;
      }
      elseif ($length[$i - 1][$j] >= $length[$i][$j - 1]) {
        $i--;
      }
      else {
        $j--;
      }
    }
    return $kept;
  }

  /**
   * A step's pending entry in its settled shape, or NULL when not pending.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step.
   *
   * @return array{by: int[], ok: array[]}|null
   *   The entry.
   */
  private function pendingEntry(array $block, string $step): ?array {
    $entry = $block[self::PENDING_PREFIX . $step] ?? NULL;
    if (!is_array($entry)) {
      return NULL;
    }
    return [
      'by' => array_values(array_unique(array_map('intval', $entry['by'] ?? []))),
      'ok' => array_values(array_filter($entry['ok'] ?? [], 'is_array')),
    ];
  }

  /**
   * The block with `$uids` in a step's baseline and its approvals dropped.
   *
   * The baseline grows rather than being replaced, and that is what heals a
   * block marked for nobody: an empty `by` says this step is waiting on writing
   * no server could attribute ({@see self::markUnaccounted()}), and the next
   * identified edit adds a real writer to it — turning a block nobody may
   * approve into an ordinary episode with an author and a reviewer.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step.
   * @param int[] $uids
   *   The accounts that wrote.
   *
   * @return array
   *   The block's new sidecar entry.
   */
  private function markPending(array $block, string $step, array $uids): array {
    $block = $this->widenPending($block, $step, $uids);
    $block[self::PENDING_PREFIX . $step]['ok'] = [];
    return $block;
  }

  /**
   * The block with `$uids` in a step's baseline and its approvals left alone.
   *
   * For a write that named these accounts without moving the block's text
   * ({@see self::carrySession()}): they have to be in the baseline or they are
   * outsiders to their own writing, but nothing here outdates a sign-off.
   *
   * Widening can only make a step harder to satisfy — an approver already
   * recorded stays recorded, and a baseline with one more name in it needs one
   * more pair of eyes, never fewer.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step.
   * @param int[] $uids
   *   The accounts that wrote.
   *
   * @return array
   *   The block's new sidecar entry.
   */
  private function widenPending(array $block, string $step, array $uids): array {
    $entry = $this->pendingEntry($block, $step) ?? ['by' => [], 'ok' => []];
    foreach ($uids as $uid) {
      if (!in_array($uid, $entry['by'], TRUE)) {
        $entry['by'][] = $uid;
      }
    }
    $block[self::PENDING_PREFIX . $step] = $entry;
    return $block;
  }

  /**
   * The block with a step waiting on writing nobody can be named for.
   *
   * The counterpart of {@see self::markPending()}, and the only stamp that
   * *replaces* a baseline: an episode already naming an author would otherwise
   * survive this write and let that author sign off text they never wrote
   * ({@see self::stampSession()}). Approvals go with the names — given to what
   * the block held before, which this write moved.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param string $step
   *   The step.
   *
   * @return array
   *   The block's new sidecar entry.
   */
  private function markUnaccounted(array $block, string $step): array {
    $block[self::PENDING_PREFIX . $step] = ['by' => [], 'ok' => []];
    return $block;
  }

  /**
   * Whether a step's collected approvals satisfy it.
   *
   * @param string $step
   *   The step.
   * @param array{by: int[], ok: array[]} $pending
   *   The step's pending entry.
   *
   * @return bool
   *   TRUE when the step is done.
   */
  private function satisfies(string $step, array $pending): bool {
    $approvers = array_map(static fn (array $ok): int => (int) $ok['uid'], $pending['ok']);
    if ($step === self::STEP_AGENT) {
      return $approvers !== [];
    }
    if (array_diff($approvers, $pending['by']) !== []) {
      return TRUE;
    }
    return count($pending['by']) >= 2 && array_diff($pending['by'], $approvers) === [];
  }

  /**
   * The baseline a settled step is re-opened on.
   *
   * The record's own, where it carries one. A record that does not is one this
   * model cannot ask what it settled, and the one answer it may not give is
   * "nobody": a baseline of one name is satisfied by anybody outside it, so a
   * step re-opened naming only the account this write happens to name is a step
   * the block's author can then clear alone — over their own writing, which is
   * the single thing the four-eyes rule exists to refuse.
   *
   * Every account the block records a contribution for is the answer instead.
   * It is the wider of the two — widening only ever makes a step harder to
   * satisfy — and it holds the author of the block by construction.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param array|null $settled
   *   The step's settled sign-off, or NULL when it has none.
   *
   * @return int[]
   *   The accounts the re-opened step names, before this write's own.
   */
  private function settledBaseline(array $block, ?array $settled): array {
    if ($settled === NULL) {
      return [];
    }
    if (array_key_exists('by', $settled)) {
      return array_map('intval', $settled['by']);
    }
    return array_map(
      static fn (array $contributor): int => (int) $contributor['uid'],
      $this->contributors($block),
    );
  }

  /**
   * The block's contributor records, one per acting identity.
   *
   * @param array $block
   *   The block's sidecar entry.
   *
   * @return array[]
   *   The records.
   */
  private function contributors(array $block): array {
    return array_values(array_filter($block['contributors'] ?? [], 'is_array'));
  }

  /**
   * The block with one acting identity recorded as a contributor.
   *
   * An account and the same account acting through an agent are separate
   * identities: "fago" and "fago via Claude" wrote different things and the
   * byline says so.
   *
   * @param array $block
   *   The block's sidecar entry.
   * @param int $uid
   *   The account that wrote.
   * @param string|null $via
   *   The agent label the account acted through.
   * @param string|null $name
   *   The account's display name.
   * @param int $at
   *   The write's timestamp.
   *
   * @return array
   *   The block's new sidecar entry.
   */
  private function addContribution(array $block, int $uid, ?string $via, ?string $name, int $at): array {
    $contributors = $this->contributors($block);
    foreach ($contributors as $index => $contributor) {
      if ((int) $contributor['uid'] === $uid && ($contributor['via'] ?? NULL) === $via) {
        $contributors[$index]['lastEdit'] = $at;
        $contributors[$index]['name'] = $name ?? $contributor['name'] ?? NULL;
        $block['contributors'] = $contributors;
        return $block;
      }
    }
    $contributors[] = [
      'uid' => $uid,
      'via' => $via,
      'name' => $name,
      'lastEdit' => $at,
    ];
    $block['contributors'] = $contributors;
    return $block;
  }

}
