<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\content_moderation\ModerationInformationInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\openkb_agent\ActingIdentity;
use Drupal\user\UserInterface;

/**
 * Credits and flags the blocks a write changed, as the write happens.
 *
 * This is where the review model gets its facts. It runs in presave, so every
 * path that saves a page goes through it whether it knows about review or
 * not — the node form, a JSON:API PATCH, the collab checkpoint, the agent
 * write surface. None of them can opt out, reorder it, or hand in a different
 * answer: the changed blocks come from diffing the body against the revision
 * being written on top of, and the credential comes from the authenticated
 * request.
 *
 * The other half of that guarantee is that no client can write the sidecar
 * itself — see openkb_workflow_entity_field_access(). Together they mean the
 * only sidecar values that exist are ones a server witnessed being earned.
 *
 * Not only blocks: every difference between the draft and the published
 * revision is a review item (ADR 0017), so a block the body no longer holds
 * keeps its record, marked deleted, and the title takes an entry of its own.
 * A block this write puts back to what the published revision says, where it
 * says it, carries that revision's own record — text the live page already
 * shows owes no review and credits nobody new.
 *
 * The one write whose credit does not come from the request's own credential is
 * a collaborative session's checkpoint, which is one request carrying several
 * peers' keystrokes. It states its own accounting alongside the text, and the
 * two are recorded together — see
 * {@see \Drupal\openkb_workflow\CollabServerIdentity} and
 * {@see \Drupal\openkb_workflow\PageBlocks::stampSession()}.
 */
final class BlockAttribution {

  use PageRevisionsTrait;

  /**
   * The only bundle carrying a review sidecar.
   */
  private const BUNDLE = 'kb_page';

  /**
   * The field holding the page's markdown.
   */
  private const BODY_FIELD = 'field_kb_body';

  /**
   * The field holding the review sidecar.
   */
  private const SIDECAR_FIELD = 'field_block_meta';

  /**
   * Passes already made this request, keyed by everything one reads.
   *
   * @var array<string, array{blocks: array<string, array>, approved: list<array>, refused: list<array>}>
   */
  private array $passes = [];

  public function __construct(
    private readonly ActingIdentity $identity,
    private readonly TimeInterface $time,
    private readonly PageBlocks $pageBlocks,
    private readonly CollabServerIdentity $collabServer,
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly ReviewPolicy $reviewPolicy,
    private readonly ?ModerationInformationInterface $moderationInformation,
  ) {}

  /**
   * {@inheritdoc}
   */
  protected function revisionStorage(): NodeStorageInterface {
    /** @var \Drupal\node\NodeStorageInterface $storage */
    $storage = $this->entityTypeManager->getStorage('node');
    return $storage;
  }

  /**
   * Attributes and flags what this save changed.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   */
  public function attribute(NodeInterface $node): void {
    // Imported content arrives as its export said — a syncing save (recipe
    // content, default_content) is nobody's edit to stamp.
    if ($node->isSyncing() || !$this->carriesBlocks($node)) {
      return;
    }
    $encoded = $this->pageBlocks->encode($this->projected($node));
    if ($encoded !== (string) $node->get(self::SIDECAR_FIELD)->value) {
      $node->set(self::SIDECAR_FIELD, $encoded === '' ? NULL : $encoded);
    }
  }

  /**
   * What blocks publication of this write, or nothing.
   *
   * The one gate's decision (ADR 0004), enforced at the wire: the
   * OkbPendingReview entity constraint refuses the write on every validated
   * surface (JSON:API validates all writes), and the commit routes divert a
   * blocked content write to a draft before validation runs. Programmatic
   * saves do not validate and are deliberately untouched — seeds, migrations
   * and workflows publish as they always did; presave only logs when one
   * slips through with blockers.
   *
   * Everything that would produce a published default revision is judged on
   * the projected sidecar — the review this very write owes counts too. The
   * one exemption is metadata churn on an already-live page (stored
   * default published, no content moved): approvals and state-keeping saves
   * pass, while a creation that publishes itself and a state-only publish of
   * a draft-default page are both publication events and answer for their
   * pending blocks.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return array<string, string[]>
   *   Review item => pending steps, empty when the write may publish.
   */
  public function publicationHold(NodeInterface $node): array {
    if (!$this->isPublicationEvent($node)) {
      return [];
    }
    return $this->pageBlocks->blockers(
      $this->projected($node),
      $this->reviewPolicy->enforcedSteps($node),
    );
  }

  /**
   * Whether this write would publish text outside identified blocks.
   *
   * Every block the editor produces carries an id (containers ride the
   * `::block{#id}` wrapper fence), so an id-less remainder only arrives via a
   * raw write. It cannot be flagged, approved or credited — there is no
   * review lane for it, only a refusal (the OkbPendingReview constraint's
   * second message).
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return bool
   *   TRUE when the write must be refused.
   */
  public function unidentifiedHold(NodeInterface $node): bool {
    return $this->isPublicationEvent($node)
      && $this->pageBlocks->unaddressed((string) $node->get(self::BODY_FIELD)->value) !== '';
  }

  /**
   * Whether this write is a publication event the gate judges.
   *
   * A syncing save (recipe content, default_content) is a seed, not an
   * editorial act — core's importer validates, so the exemption for
   * programmatic writes has to be stated here, not assumed. Metadata churn on
   * a page that is already live (stored default published AND no content
   * moved) is exempt: approvals and state-keeping saves pass. Everything else
   * that would produce a published default revision answers — a creation that
   * publishes itself, and a state-only publish of a draft-default page
   * (the state change IS the publication) included.
   */
  private function isPublicationEvent(NodeInterface $node): bool {
    if ($node->isSyncing() || !$this->carriesBlocks($node) || !$this->wouldPublishDefault($node)) {
      return FALSE;
    }
    if ($node->isNew()) {
      return TRUE;
    }
    // Against the STORED DEFAULT, not the latest revision: publishing a
    // pending forward draft is a publication of ITS content, and diffing
    // against the draft itself would read it as "no change on a live
    // page" and wave it through.
    $stored = $this->storedLive($node);
    return $stored === NULL || $this->contentDiffers($node, $stored);
  }

  /**
   * Whether this write says something different from the stored revision.
   *
   * Every kind of difference, because every kind of difference is reviewed
   * (ADR 0017): a block whose bytes or place moved, a block that is gone, a
   * reviewed field, and — as text — everything OUTSIDE identified blocks, so
   * content whose ids were stripped still counts as a change and an id-less
   * rewrite cannot slip the gate (ADR 0004).
   */
  private function contentDiffers(NodeInterface $node, ?NodeInterface $stored): bool {
    $body = (string) $node->get(self::BODY_FIELD)->value;
    $stored_body = (string) ($stored?->get(self::BODY_FIELD)->value ?? '');
    return $this->pageBlocks->changed($body, $stored_body) !== []
      || $this->pageBlocks->removed($body, $stored_body) !== []
      || $stored?->label() !== $node->label()
      || $this->pageBlocks->unaddressed($body) !== $this->pageBlocks->unaddressed($stored_body);
  }

  /**
   * Whether this write, as it stands, would become the published live revision.
   *
   * Read from the target moderation state's own flags rather than a state name:
   * the live page is the default revision and shows it once that revision is
   * published — the two flags the workflow records for every state. A node no
   * workflow moderates, or one carrying a state the workflow does not define,
   * is not something this gate speaks to.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return bool
   *   TRUE when the write would land published and default.
   */
  private function wouldPublishDefault(NodeInterface $node): bool {
    if ($this->moderationInformation === NULL || !$this->moderationInformation->isModeratedEntity($node)) {
      return FALSE;
    }
    $workflow = $this->moderationInformation->getWorkflowForEntity($node);
    $state = $workflow?->getTypePlugin()->getConfiguration()['states'][(string) $node->get('moderation_state')->value] ?? NULL;
    return is_array($state) && !empty($state['published']) && !empty($state['default_revision']);
  }

  /**
   * The sidecar this save will leave behind, without writing it.
   *
   * The publish gate judges the page this write is about to produce, not
   * the one it replaces — so gate and write agree by construction.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return array<string, array>
   *   Review item => its sidecar entry.
   */
  public function projected(NodeInterface $node): array {
    return $this->project($node)['blocks'];
  }

  /**
   * What the sign-offs this save states became of.
   *
   * The same pass {@see self::projected()} runs, asked for its other answer.
   * Ask before the save: afterwards the sidecar already carries the sign-offs
   * and no review step is left for them to clear.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return array{approved: list<array{item: string, step: string, uid: int}>, refused: list<array{item: string, step: string, uid: int, reason: string}>}
   *   What was recorded, and what was turned down with the reason. Each entry
   *   names the account that signed off, so a peer reading the relayed answer
   *   tells its own sign-off from a colleague's.
   */
  public function signOffs(NodeInterface $node): array {
    $pass = $this->project($node);
    return ['approved' => $pass['approved'], 'refused' => $pass['refused']];
  }

  /**
   * The sidecar this save produces, and what its stated sign-offs did.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return array{blocks: array<string, array>, approved: list<array>, refused: list<array>}
   *   The sidecar this save writes, and what became of every stated sign-off.
   */
  private function project(NodeInterface $node): array {
    if (!$this->carriesBlocks($node)) {
      return ['blocks' => [], 'approved' => [], 'refused' => []];
    }
    $key = $this->passKey($node);
    if (isset($this->passes[$key])) {
      return $this->passes[$key];
    }
    return $this->passes[$key] = $this->pass($node);
  }

  /**
   * Everything a pass reads, so a repeat of the same one is served twice.
   *
   * The key has to separate two checkpoints that leave the entity identical,
   * which a commit writing no revision does, so the statement each one
   * carries is part of it alongside the sidecar the presave stamp writes.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return string
   *   The memo key.
   */
  private function passKey(NodeInterface $node): string {
    return implode('|', [
      $node->uuid(),
      (string) $node->getLoadedRevisionId(),
      $node->hasField('moderation_state') ? (string) $node->get('moderation_state')->value : '',
      $this->collabServer->isSessionWrite() ? '1' : '0',
      (string) $this->identity->uid(),
      (string) $this->identity->via(),
      md5((string) $node->get(self::BODY_FIELD)->value),
      md5((string) $node->get(self::SIDECAR_FIELD)->value),
      md5(serialize([$this->collabServer->writers(), $this->collabServer->actions()])),
    ]);
  }

  /**
   * One pass over the page: the sidecar it produces and the sign-offs' fate.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return array{blocks: array<string, array>, approved: list<array>, refused: list<array>}
   *   The sidecar this save writes, and what became of every stated sign-off.
   */
  private function pass(NodeInterface $node): array {
    $body = (string) $node->get(self::BODY_FIELD)->value;
    $base = $this->baseRevision($node);
    $base_body = (string) ($base?->get(self::BODY_FIELD)->value ?? '');
    $changed = $this->pageBlocks->changed($body, $base_body);
    // A removal and a field edit are changes with no text of their own to
    // flag, so they take their entries here beside the blocks and are stamped
    // by the same credential (ADR 0017). They are stamped apart from the
    // blocks because they have no text a later edit could re-stamp.
    $textless = array_merge(
      $this->pageBlocks->removed($body, $base_body),
      $this->changedFields($node, $base),
    );
    $written = array_merge($changed, $textless);

    // Read what the entity carries rather than what storage holds: the
    // presave stamp writes the sidecar onto this very revision, and the
    // publication hold and the constraint read it after that.
    $blocks = $this->pageBlocks->decode($node->get(self::SIDECAR_FIELD)->value);

    // A shared session's checkpoint carries several peers' writing under one
    // credential, so the account it authenticated as is not the answer to who
    // wrote it. The checkpoint says so itself, per block, in this very request.
    // Everything else is one account writing, and that account is credited.
    $session = $this->collabServer->isSessionWrite();
    $uid = $this->identity->uid();
    $via = $this->identity->via();
    $name = $this->identity->name();
    $at = $this->time->getRequestTime();

    $writers = $session ? $this->sessionWriters() : [];
    $moved = $session ? array_flip($this->pageBlocks->moved($body, $base_body)) : [];
    foreach ($changed as $id) {
      $set = $writers[$id] ?? [];
      // A block that only took another place has no writing for the window to
      // witness, so the account the checkpoint acts as is its writer.
      if ($set === [] && isset($moved[$id])) {
        $set = [['uid' => $uid, 'via' => $via, 'name' => $name]];
      }
      $blocks[$id] = $session
        ? $this->pageBlocks->stampSession($blocks[$id] ?? [], $set, $at)
        : $this->pageBlocks->stamp($blocks[$id] ?? [], $uid, $via, $name, $at);
    }
    foreach ($textless as $id) {
      $blocks[$id] = $session
        ? $this->pageBlocks->stampItem($blocks[$id] ?? [], $writers[$id] ?? [], $at)
        : $this->pageBlocks->stamp($blocks[$id] ?? [], $uid, $via, $name, $at);
    }

    // The rule is the whole difference against the live page, while the
    // stamping above is only the difference this save made. An entry already
    // there is left alone, sign-offs included; a missing one opens against the
    // live record of what is taken away, naming nobody where there is none.
    foreach ($this->carriedItems($node, $body) as $id => $live_entry) {
      $blocks[$id] ??= $this->pageBlocks->stampItem($live_entry, [], $at);
    }

    // A checkpoint's owed window covers blocks this diff is silent about: the
    // text may already have been stored by another path, but its typists still
    // have to reach the block's four-eyes baseline. carrySession() books that
    // baseline without re-opening or re-crediting the block.
    foreach (array_diff_key($writers, array_flip($written)) as $id => $set) {
      $blocks[$id] = $this->pageBlocks->carrySession($blocks[$id] ?? [], $set, $at);
    }

    $blocks = $this->reviewItems($node, $body, $blocks);
    $blocks = $this->settledAgainstLive($node, $body, $changed, $blocks);

    // Last, after this save's own writers are on the changed blocks: a
    // reviewer who edited a block in this checkpoint is in its writer set, so
    // mayApprove() refuses them. That is where four-eyes is kept.
    return $this->applySignOffs($node, $blocks);
  }

  /**
   * Records the sign-offs the checkpoint states, on the sidecar it writes.
   *
   * A sign-off naming a block the sidecar does not carry is dropped in
   * silence, as one on a review step somebody else already settled is: both
   * are the ordinary race between a sign-off and the checkpoint it rode on,
   * and there is nothing the reviewer could do about either.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   * @param array<string, array> $blocks
   *   The sidecar this save writes, before the sign-offs.
   *
   * @return array{blocks: array<string, array>, approved: list<array>, refused: list<array>}
   *   The sidecar with the recorded sign-offs on it, and the fate of each.
   */
  private function applySignOffs(NodeInterface $node, array $blocks): array {
    $approved = [];
    $refused = [];
    // One reviewer clears many blocks on a page; who they are and what they
    // may do here is the same answer every time.
    $standing = [];
    $at = $this->time->getRequestTime();
    // The revision the reviewer read, which is the one this save is made on.
    $vid = (int) $node->getLoadedRevisionId();

    foreach ($this->collabServer->actions() as $action) {
      ['item' => $id, 'step' => $step, 'uid' => $uid] = $action;
      if ($action['via'] !== NULL) {
        // Refused here, not only at the collaboration server: the gate fails
        // closed on Drupal's own side of the wire (ADR 0004).
        $refused[] = [
          'item' => $id,
          'step' => $step,
          'uid' => $uid,
          'reason' => 'An agent may not sign off a review step.',
        ];
        continue;
      }
      $standing[$uid] ??= $this->reviewerStanding($node, $uid);
      ['account' => $account, 'admin' => $is_admin, 'refusal' => $refusal] = $standing[$uid];
      if ($refusal !== NULL) {
        $refused[] = ['item' => $id, 'step' => $step, 'uid' => $uid, 'reason' => $refusal];
        continue;
      }
      if (!isset($blocks[$id]) || !$this->pageBlocks->isPending($blocks[$id], $step)) {
        continue;
      }
      if (!$this->pageBlocks->mayApprove($blocks[$id], $step, $uid, $is_admin)) {
        $refused[] = [
          'item' => $id,
          'step' => $step,
          'uid' => $uid,
          'reason' => $this->pageBlocks->refusalReason($blocks[$id], $step, $id),
        ];
        continue;
      }
      $blocks[$id] = $this->pageBlocks->approve($blocks[$id], $step, $uid, $account->getDisplayName(), $at, $vid, $is_admin);
      $approved[] = ['item' => $id, 'step' => $step, 'uid' => $uid];
    }

    return ['blocks' => $blocks, 'approved' => $approved, 'refused' => $refused];
  }

  /**
   * Who the signing account is here, and whether it may sign off at all.
   *
   * Asked once per account: the answer does not vary by block.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being signed off.
   * @param int $uid
   *   The account signing off.
   *
   * @return array{account: \Drupal\user\UserInterface|null, admin: bool, refusal: string|null}
   *   The account, whether it may moderate past the four-eyes rule, and the
   *   sentence refusing every one of its sign-offs, or NULL for none.
   */
  private function reviewerStanding(NodeInterface $node, int $uid): array {
    $account = $this->entityTypeManager->getStorage('user')->load($uid);
    if (!$account instanceof UserInterface || !$account->isActive()) {
      return ['account' => NULL, 'admin' => FALSE, 'refusal' => 'The account that signed off is blocked or gone.'];
    }
    // Update access is the editor roster inside a space, so an ordinary
    // reviewer signs off only where they may edit; a global admin also answers
    // for unaccounted blocks in spaces they are not rostered on (ADR 0004).
    $is_admin = $this->reviewPolicy->mayModerate($node, $account);
    return [
      'account' => $account,
      'admin' => $is_admin,
      'refusal' => $is_admin || $node->access('update', $account)
        ? NULL
        : sprintf('%s may not sign off on this page.', $account->getAccountName()),
    ];
  }

  /**
   * The review items this write's page still carries, as a sidecar.
   *
   * A block the body holds always does. The two entries with no text of their
   * own stand for as long as a reader could see the difference they are about,
   * which is for as long as the live page still disagrees with the draft:
   *
   * - a removed block's record, while the live page still shows the block;
   * - a reviewed field's entry, while the live page still shows another value.
   *
   * Against the STORED default revision, which for a write that publishes
   * itself is the revision it replaces — so the entry is still here when the
   * gate reads it, and gone from the draft that follows.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   * @param string $body
   *   The body being written.
   * @param array<string, array> $blocks
   *   The sidecar as the stamping left it.
   *
   * @return array<string, array>
   *   The entries that stand, the removed blocks' marked as deleted.
   */
  private function reviewItems(NodeInterface $node, string $body, array $blocks): array {
    $present = $this->pageBlocks->segment($body);
    $live = $this->storedLive($node);
    $live_body = $live === NULL ? '' : (string) $live->get(self::BODY_FIELD)->value;
    $live_blocks = $this->pageBlocks->segment($live_body);
    $moved = $live === NULL
      ? []
      : array_flip($this->pageBlocks->moved($body, $live_body));

    $items = [];
    foreach ($blocks as $key => $entry) {
      if (isset($present[$key])) {
        $items[$key] = isset($moved[$key])
          ? $this->pageBlocks->markMoved($entry)
          : $this->pageBlocks->markPresent($entry);
      }
      elseif ($key === PageBlocks::FIELD_TITLE) {
        if ($live !== NULL && $live->label() !== $node->label()) {
          $items[$key] = $entry;
        }
      }
      elseif (isset($live_blocks[$key])) {
        $items[$key] = $this->pageBlocks->markDeleted($entry);
      }
    }
    return $items;
  }

  /**
   * The entries of the reviewed fields this write says differently.
   *
   * The title is the page's one reviewed field: it is what the page is
   * called, so changing it changes what the live page says as surely as a
   * paragraph does — and no block carries it, because the frontend splits its
   * markdown heading off at the read boundary
   * ({@see \Drupal\openkb_workflow\PageBlocks::segment()}).
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   * @param \Drupal\node\NodeInterface|null $against
   *   The revision to measure it against — the base revision for what this
   *   write changed, the live one for what the draft carries.
   *
   * @return list<string>
   *   The differing fields' sidecar keys.
   */
  private function changedFields(NodeInterface $node, ?NodeInterface $against): array {
    return $against !== NULL && $against->label() === $node->label()
      ? []
      : [PageBlocks::FIELD_TITLE];
  }

  /**
   * The textless differences the draft carries against the live page.
   *
   * Each maps to the live revision's own record of what is taken away, which
   * the caller opens an entry from where the sidecar carries none. A
   * never-published page differs from no live page and returns nothing.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   * @param string $body
   *   The body being written.
   *
   * @return array<string, array>
   *   Review item => the live revision's entry for it, empty when it has none.
   */
  private function carriedItems(NodeInterface $node, string $body): array {
    $live = $this->storedLive($node);
    if ($live === NULL) {
      return [];
    }
    $live_blocks = $this->pageBlocks->decode($live->get(self::SIDECAR_FIELD)->value);
    $ids = array_merge(
      $this->pageBlocks->removed($body, (string) $live->get(self::BODY_FIELD)->value),
      $this->changedFields($node, $live),
    );

    $items = [];
    foreach ($ids as $id) {
      $items[$id] = $live_blocks[$id] ?? [];
    }
    return $items;
  }

  /**
   * Restores the published record for blocks this write put back to live text.
   *
   * A block this write moved that ends up saying what the published revision
   * says, in the place it says it, is the published block: it is already on
   * the live page, so it holds no publication up and earned nobody new credit.
   * It takes over the published revision's entry whole — flags, sign-offs and
   * contributors — because ModerationStatusController::differs() reads any
   * sidecar differing from the published one as unpublished changes.
   *
   * Only the blocks this write moved: a block it left alone may carry the
   * four-eyes baseline a checkpoint's owed window books
   * ({@see \Drupal\openkb_workflow\PageBlocks::carrySession()}), a fact the
   * live page never witnessed.
   *
   * The comparison happens here rather than on the caller's word: the sidecar
   * is server-witnessed (openkb_workflow_entity_field_access()), so no client
   * can clear a flag by claiming its block matches the live page.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   * @param string $body
   *   The body being written.
   * @param string[] $changed
   *   The ids of the blocks this write moved.
   * @param array<string, array> $blocks
   *   The sidecar as the stamping left it.
   *
   * @return array<string, array>
   *   The sidecar with the live blocks' own entries restored.
   */
  private function settledAgainstLive(NodeInterface $node, string $body, array $changed, array $blocks): array {
    $live = $this->liveRevision($node);
    if ($live === NULL) {
      return $blocks;
    }
    $segments = $this->pageBlocks->segment($body);
    // Against the live body as a whole, not block by block: a block whose
    // bytes match the live page's but whose place does not is not the
    // published block — the page reads differently for the move, and that is
    // the change under review (ADR 0017).
    $moved = array_flip($this->pageBlocks->changed(
      $body,
      (string) $live->get(self::BODY_FIELD)->value,
    ));
    $live_blocks = $this->pageBlocks->decode($live->get(self::SIDECAR_FIELD)->value);
    foreach (array_keys(array_intersect_key($segments, array_flip($changed))) as $id) {
      if (isset($moved[$id])) {
        continue;
      }
      // A live block with no record of its own leaves the block with none:
      // an empty entry is not the published block's answer, it is a block the
      // sidecar does not speak about.
      if (isset($live_blocks[$id])) {
        $blocks[$id] = $live_blocks[$id];
      }
      else {
        unset($blocks[$id]);
      }
    }
    return $blocks;
  }

  /**
   * The revision the live page shows, for a write that is not it.
   *
   * Only a forward draft is settled against the live page. A write that
   * publishes itself BECOMES the live page, so measuring it against the
   * revision it replaces would put that revision's sidecar back over the record
   * the write is making — and a page no workflow moderates has no forward
   * draft at all.
   *
   * The STORED default revision: a write in flight is not what readers see, and
   * on a never-published page there is no live text to settle against.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return \Drupal\node\NodeInterface|null
   *   The published default revision, or NULL when the rule does not apply.
   */
  private function liveRevision(NodeInterface $node): ?NodeInterface {
    if ($this->moderationInformation === NULL
      || !$this->moderationInformation->isModeratedEntity($node)
      || $this->wouldPublishDefault($node)) {
      return NULL;
    }
    return $this->storedLive($node);
  }

  /**
   * The revision readers see right now, or NULL when they see none.
   *
   * The STORED default revision, loaded unchanged: a write in flight is not
   * what readers see, and the caller is usually holding that very revision
   * with its new values already applied.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return \Drupal\node\NodeInterface|null
   *   The published default revision, or NULL when there is none.
   */
  private function storedLive(NodeInterface $node): ?NodeInterface {
    if ($node->isNew()) {
      return NULL;
    }
    $stored = $this->entityTypeManager->getStorage('node')->loadUnchanged($node->id());
    return $stored instanceof NodeInterface && $stored->isPublished() ? $stored : NULL;
  }

  /**
   * The checkpoint's writer sets, with each account's name resolved.
   *
   * The wire carries account ids and agent labels; the byline needs names, and
   * a name is Drupal's fact about an account rather than anything the
   * collaboration server should be trusted to spell. A witnessed writer stays
   * in the set whatever became of the account since — membership decides
   * four-eyes and the agent step (ADR 0002), and dropping a since-blocked
   * writer would replace a named episode with an unaccounted one and lose an
   * agent's `via`. An account that cannot be loaded merely loses its display
   * name.
   *
   * @return array<string, list<array{uid: int, via: string|null, name: string|null}>>
   *   Block id => its resolved writer set.
   */
  private function sessionWriters(): array {
    $writers = $this->collabServer->writers();
    $uids = [];
    foreach ($writers as $set) {
      foreach ($set as $writer) {
        $uids[] = $writer['uid'];
      }
    }
    $names = $this->accountNames($uids);

    $resolved = [];
    foreach ($writers as $id => $set) {
      foreach ($set as $writer) {
        $resolved[$id][] = [
          'uid' => $writer['uid'],
          'via' => $writer['via'],
          'name' => $names[$writer['uid']] ?? NULL,
        ];
      }
    }
    return $resolved;
  }

  /**
   * The display names of those `$uids` that still resolve to an account.
   *
   * One load for the whole window: a checkpoint's map repeats the same handful
   * of peers on every block it touches. Only the name is display data — the
   * writer's membership never depends on it.
   *
   * @param int[] $uids
   *   The account ids to resolve.
   *
   * @return array<int, string>
   *   Account id => account name.
   */
  private function accountNames(array $uids): array {
    $names = [];
    foreach ($this->entityTypeManager->getStorage('user')->loadMultiple(array_unique($uids)) as $uid => $user) {
      $names[(int) $uid] = (string) $user->getAccountName();
    }
    return $names;
  }

  /**
   * Whether this entity is a page with a body and a sidecar to attribute.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The entity.
   *
   * @return bool
   *   TRUE when the review model applies to it.
   */
  private function carriesBlocks(NodeInterface $node): bool {
    return $node->bundle() === self::BUNDLE
      && $node->hasField(self::BODY_FIELD)
      && $node->hasField(self::SIDECAR_FIELD);
  }

}
