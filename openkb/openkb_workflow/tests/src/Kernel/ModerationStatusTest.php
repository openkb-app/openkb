<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_workflow\Kernel;

use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_workflow\PageBlocks;

/**
 * The moderation status the editor chrome renders from.
 *
 * `GET /openkb/node/{node}/moderation` answers the questions the frontend
 * cannot answer for itself, and the whole point is that its answers are
 * Drupal's: the badge shows the working copy's state, "unpublished changes"
 * means a forward draft really exists, and `canPublish` is the transition
 * check the write itself answers to — so a user who sees the Publish button
 * can publish, and one who cannot never sees it.
 *
 * The users here carry exactly the permissions the shipped recipe grants
 * `authenticated`, read from the real recipe.yml — the publish transition
 * among them, which is what this endpoint has to report.
 *
 * @group openkb_workflow
 */
final class ModerationStatusTest extends OpenkbRequestKernelTestBase {

  /**
   * A body divided into blocks a review step can be owed against.
   */
  private const BLOCKS = "Intro. {#b-one}\n\nDetail. {#b-two}";

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbReviewConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->container->get('router.builder')->rebuild();
  }

  /**
   * A published page with nothing pending: live, and nothing to revert.
   */
  public function testPublishedPageWithoutDraft(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published');

    $status = $this->readStatus($page, $editor);

    $this->assertTrue($status['moderated']);
    $this->assertSame('published', $status['state']);
    $this->assertTrue($status['hasPublishedRevision']);
    $this->assertFalse($status['hasUnpublishedChanges']);
  }

  /**
   * A forward draft on a published page — the case the badge exists for.
   *
   * The state describes the *working copy* (draft), while the live page is
   * still the published revision. Reporting the default revision's state
   * instead would tell an editor their draft is live.
   */
  public function testForwardDraftIsReportedAsUnpublishedChanges(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published');
    $this->addForwardDraft($page);

    $status = $this->readStatus($page, $editor);

    $this->assertSame('draft', $status['state']);
    $this->assertTrue($status['hasPublishedRevision']);
    $this->assertTrue($status['hasUnpublishedChanges']);
  }

  /**
   * A never-published page: no live revision, so nothing to revert to.
   */
  public function testNeverPublishedPage(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'draft');

    $status = $this->readStatus($page, $editor);

    $this->assertSame('draft', $status['state']);
    $this->assertFalse($status['hasPublishedRevision']);
    // The default revision *is* the newest one — a draft-only page has no
    // pending revision, it is pending in its entirety.
    $this->assertFalse($status['hasUnpublishedChanges']);
  }

  /**
   * A draft whose content equals published is not "unpublished changes".
   *
   * This is the state a document revert leaves behind: a new draft revision
   * holding the published content, written rather than deleting anything. A
   * badge that then reads "unpublished changes" — and a Revert control that
   * offers to do it again — tells the editor their revert did not work.
   */
  public function testDraftMatchingPublishedIsNotPending(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published');
    $this->addForwardDraft($page);
    $this->assertTrue($this->readStatus($page, $editor)['hasUnpublishedChanges']);

    // What a revert writes: the published body back, as another draft.
    $page->setNewRevision(TRUE);
    $page->set('moderation_state', 'draft');
    $page->set('field_kb_body', ['value' => 'Body.', 'format' => 'comark']);
    $page->save();

    $status = $this->readStatus($page, $editor);
    $this->assertSame('draft', $status['state']);
    $this->assertFalse($status['hasUnpublishedChanges']);
  }

  /**
   * After a revert the page has no unpublished changes left.
   *
   * A revert writes the published body back as a new draft. The commit route
   * drops `field_block_meta` from that write (CommitResource::buildDocument),
   * so the sidecar is Drupal's to settle and every block the revert put back is
   * one the live page already shows.
   *
   * The badge and the Revert control both read `hasUnpublishedChanges`, so a
   * revert that leaves it TRUE is a revert that visibly did nothing.
   */
  public function testRevertLeavesNoUnpublishedChanges(): void {
    $editor = $this->createEditor();
    $space = $this->createSpace($editor, TRUE);
    $page = $this->createPage($editor->id(), 'published', $space, self::BLOCKS);
    $live = $this->defaultRevision($page)->get('field_block_meta')->value;

    $this->addForwardDraft($page, "Intro. {#b-one}\n\nDetail, rewritten. {#b-two}", $editor);
    $this->assertTrue($this->readStatus($page, $editor)['hasUnpublishedChanges']);

    $this->revert($page, self::BLOCKS, $editor);

    $status = $this->readStatus($page, $editor);
    $this->assertFalse(
      $status['hasUnpublishedChanges'],
      'the draft the revert wrote holds the published content and nothing else',
    );
    $this->assertSame(
      (string) $live,
      (string) $this->workingCopy($page)->get('field_block_meta')->value,
      'the sidecar is back to the published record too, or the revision still differs',
    );
    $this->assertSame(
      [],
      $this->blockersOf($this->workingCopy($page), $status['reviewSteps']),
      'a document identical to the live page owes no review',
    );
  }

  /**
   * A revert clears the review the reverted draft owed.
   *
   * A draft whose blocks are waiting on the peer step cannot be published. A
   * block whose text is back to the live page's holds nothing up, so the revert
   * has to clear those steps as well — a Publish still refused after a revert
   * would leave the page stuck.
   */
  public function testRevertClearsTheReviewTheDraftOwed(): void {
    $editor = $this->createEditor();
    $space = $this->createSpace($editor, TRUE);
    $page = $this->createPage($editor->id(), 'published', $space, self::BLOCKS);

    $this->addForwardDraft($page, "Intro, rewritten. {#b-one}\n\nDetail, rewritten. {#b-two}", $editor);
    $this->assertSame(
      ['b-one' => [PageBlocks::STEP_PEER], 'b-two' => [PageBlocks::STEP_PEER]],
      $this->blockersOf($this->workingCopy($page), [PageBlocks::STEP_PEER]),
    );

    $this->revert($page, self::BLOCKS, $editor);

    $this->assertSame([], $this->blockersOf($this->workingCopy($page), [PageBlocks::STEP_PEER]));
    $this->assertFalse($this->readStatus($page, $editor)['hasUnpublishedChanges']);
  }

  /**
   * A partial revert leaves the blocks it did not restore flagged.
   *
   * The settling rule is per block and reads the live page: a draft still
   * saying something the live page does not still owes its review, and still
   * counts as unpublished changes.
   */
  public function testOnlyBlocksBackToTheLivePageAreSettled(): void {
    $editor = $this->createEditor();
    $space = $this->createSpace($editor, TRUE);
    $page = $this->createPage($editor->id(), 'published', $space, self::BLOCKS);

    $this->addForwardDraft($page, "Intro, rewritten. {#b-one}\n\nDetail, rewritten. {#b-two}", $editor);
    // Only b-one goes back to what is live.
    $this->addForwardDraft($page, "Intro. {#b-one}\n\nDetail, rewritten. {#b-two}", $editor);

    $this->assertSame(
      ['b-two' => [PageBlocks::STEP_PEER]],
      $this->blockersOf($this->workingCopy($page), [PageBlocks::STEP_PEER]),
    );
    $this->assertTrue($this->readStatus($page, $editor)['hasUnpublishedChanges']);
  }

  /**
   * What a revert lands in Drupal: the published body back, as a new draft.
   *
   * The sidecar is deliberately not written — the commit route strips it from
   * the payload, so this replays what actually reaches storage.
   */
  private function revert(NodeInterface $page, string $published, AccountInterface $editor): void {
    $this->setCurrentUser($editor);
    $latest = $this->workingCopy($page);
    $latest->setNewRevision(TRUE);
    $latest->set('moderation_state', 'draft');
    $latest->set('field_kb_body', ['value' => $published, 'format' => 'comark']);
    $latest->save();
  }

  /**
   * The publish flag follows write access, not a role.
   *
   * Users may self-publish what they may edit, so the page's own author
   * gets the button on the draft they wrote, and so does a colleague, who may
   * edit anything inside the space. Whoever may not edit the page never
   * reaches this endpoint at all
   * (::testReaderIsDenied), which is where the negative half lives.
   */
  public function testCanPublishFollowsWriteAccess(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published');
    $this->addForwardDraft($page);

    $this->assertTrue($this->readStatus($page, $editor)['canPublish']);

    $colleague = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $this->assertTrue($this->readStatus($page, $colleague)['canPublish']);
  }

  /**
   * The admin exception is reported, so the editor can draw who may sign off.
   *
   * The frontend derives per block whether the reader may clear it — the same
   * rule PageBlocks::mayApprove() applies — and that derivation is wrong for
   * an admin without this flag: it would tell them their own writing needs
   * somebody else's eyes. The page's author and a colleague who may publish
   * anything are both still held by the four-eyes rule.
   */
  public function testStatusReportsTheAdminException(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published');

    $this->assertFalse($this->readStatus($page, $editor)['mayModerate']);

    $colleague = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $this->assertFalse(
      $this->readStatus($page, $colleague)['mayModerate'],
      'Publishing anything is not the same right as approving your own writing.',
    );

    // The exception rides on `administer nodes` and nothing else — but this
    // endpoint is behind node.update, so the account has to be able to reach a
    // colleague's page at all before its answer means anything.
    $admin = $this->createUser(array_merge(
      $this->recipeGrantedPermissions('authenticated'),
      ['administer nodes'],
    ));
    $this->assertTrue($this->readStatus($page, $admin)['mayModerate']);
  }

  /**
   * The status is editorial information: no edit access, no answer.
   */
  public function testReaderIsDenied(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published');
    $reader = $this->createUser(['access content']);

    $response = $this->request('/openkb/node/' . $page->id() . '/moderation', $reader);
    $this->assertSame(403, $response->getStatusCode(), (string) $response->getContent());
  }

  /**
   * The status carries the space's policy: a wiki renders no moderation chrome.
   *
   * `moderated` is what makes the badge and the Publish button present or
   * absent, so a published page in an unmoderated space reports itself
   * unmoderated, with no working-copy state to show and its live revision the
   * only fact left.
   */
  public function testStatusReportsTheSpacePolicy(): void {
    $editor = $this->createEditor();

    $moderated = $this->createSpace($editor, TRUE);
    $this->assertTrue($this->readStatus($this->createPage($editor->id(), 'published', $moderated), $editor)['moderated']);

    $wiki = $this->createSpace($editor, FALSE);
    $status = $this->readStatus($this->createPage($editor->id(), 'published', $wiki), $editor);
    $this->assertFalse($status['moderated']);
    $this->assertNull($status['state']);
    $this->assertFalse($status['hasUnpublishedChanges']);
    $this->assertTrue($status['hasPublishedRevision']);
  }

  /**
   * The enforced review steps follow the space, and the chrome is told them.
   *
   * A moderated space runs both the peer and agent steps; an unmoderated one
   * still runs the agent step, which the chrome has to know about; and turning
   * agent review off leaves none.
   */
  public function testReviewStepsFollowSpacePolicy(): void {
    $editor = $this->createEditor();

    $moderated = $this->createSpace($editor, TRUE);
    $this->assertSame(
      [PageBlocks::STEP_PEER, PageBlocks::STEP_AGENT],
      $this->readStatus($this->createPage($editor->id(), 'published', $moderated), $editor)['reviewSteps'],
    );

    $wiki = $this->createSpace($editor, FALSE);
    $this->assertSame(
      [PageBlocks::STEP_AGENT],
      $this->readStatus($this->createPage($editor->id(), 'published', $wiki), $editor)['reviewSteps'],
      'A wiki space still enforces the agent step, which the chrome has to know about.',
    );

    $open = $this->createSpace($editor, FALSE);
    $open->set('field_agent_review', FALSE)->save();
    $this->assertSame(
      [],
      $this->readStatus($this->createPage($editor->id(), 'published', $open), $editor)['reviewSteps'],
    );
  }

  /**
   * OKB-173: the answers `status` is assembled from, with no forward draft.
   *
   * `getPageForEditing`'s status block is three fields over this document
   * plus a block sidecar: `draft_exists` is `hasUnpublishedChanges`,
   * `blocks_pending`
   * counts the blockers of the revision projected under `reviewSteps`, and
   * `can_publish` needs `canPublish`, something to publish, and no blocker on
   * the **working copy** — the revision a publish transitions, whichever one
   * was read. The derivation is the frontend's
   * (frontend/server/utils/kb-read.ts, covered by its own unit suite and by
   * tests/playwright/tests/mcp-page-status.spec.ts against the running stack);
   * what these cases pin is that Drupal answers its half differently in each
   * moderation state, which is what makes the block worth reading.
   *
   * A live page with nothing on top of it: nothing pending, nothing
   * unpublished — so `can_publish` comes out false however the account is
   * permitted, because a publish would write a revision that changes nothing.
   */
  public function testStatusInputsWithoutForwardDraft(): void {
    $editor = $this->createEditor();
    $space = $this->createSpace($editor, TRUE);
    $page = $this->createPage($editor->id(), 'published', $space, self::BLOCKS);

    $status = $this->readStatus($page, $editor);

    $this->assertFalse($status['hasUnpublishedChanges']);
    $this->assertSame('published', $status['state']);
    $this->assertSame([], $this->blockersOf($this->defaultRevision($page), $status['reviewSteps']));

    // A wiki space answers the same way: `canPublish` is the right, which this
    // editor holds, and "nothing to publish" is the page's condition beside
    // it — the chrome offers Publish on the two together, and on the session's
    // own unsaved keystrokes, which no status can know about.
    $wiki = $this->createSpace($editor, FALSE);
    $live = $this->createPage($editor->id(), 'published', $wiki, self::BLOCKS);
    $wiki_status = $this->readStatus($live, $editor);
    $this->assertTrue($wiki_status['canPublish']);
    $this->assertFalse($wiki_status['hasUnpublishedChanges']);
  }

  /**
   * OKB-173: a draft whose blocks still owe an enforced step.
   *
   * Two facts at once, and the pair is the point: the page has unpublished
   * changes *and* those changes are waiting for sign-off. The blockers are a
   * property of a revision, so the same page answers 1 on its working copy
   * and 0 on its published one — which is why `blocks_pending` follows the
   * revision read while `can_publish` follows the working copy: a published
   * read reporting the live page's zero as the publishability of the draft
   * above it would answer "go" on a write the gate refuses.
   */
  public function testStatusInputsWithBlocksAwaitingAnEnforcedStep(): void {
    $editor = $this->createEditor();
    $space = $this->createSpace($editor, TRUE);
    $page = $this->createPage($editor->id(), 'published', $space, self::BLOCKS);
    $this->addForwardDraft($page, "Intro. {#b-one}\n\nDetail, rewritten. {#b-two}", $editor);

    $status = $this->readStatus($page, $editor);

    $this->assertTrue($status['hasUnpublishedChanges']);
    $this->assertSame('draft', $status['state']);
    $this->assertTrue($status['canPublish']);
    $this->assertSame(
      ['b-two' => [PageBlocks::STEP_PEER]],
      $this->blockersOf($this->workingCopy($page), $status['reviewSteps']),
    );
    $this->assertSame(
      [],
      $this->blockersOf($this->defaultRevision($page), $status['reviewSteps']),
      'What is live owes nothing — the draft above it is what owes the step.',
    );
  }

  /**
   * OKB-173: a draft whose reviews have been cleared.
   *
   * The state between the two above, and the one a client cannot tell from
   * either without the block: still a draft on top of the live page, but
   * nothing left holding its publication up.
   */
  public function testStatusInputsWhenReviewsAreCleared(): void {
    $editor = $this->createEditor();
    $reviewer = $this->createUser();
    $space = $this->createSpace($editor, TRUE);
    $page = $this->createPage($editor->id(), 'published', $space, self::BLOCKS);
    $this->addForwardDraft($page, "Intro. {#b-one}\n\nDetail, rewritten. {#b-two}", $editor);
    $this->signOff($page, 'b-two', PageBlocks::STEP_PEER, $reviewer);

    $status = $this->readStatus($page, $editor);

    $this->assertTrue($status['hasUnpublishedChanges']);
    $this->assertTrue($status['canPublish']);
    $this->assertSame([], $this->blockersOf($this->workingCopy($page), $status['reviewSteps']));
  }

  /**
   * OKB-173: the standing is the caller's, not the page's.
   *
   * One page, one moment, three accounts. The roster editor is told where it
   * stands; a viewer on the same space and an editor of a different space are
   * told nothing at all — the route is gated on `node.update`, which is exactly
   * the access the CE read reports, so a caller who may not edit gets no status
   * block rather than a 403 in the middle of a page read.
   */
  public function testStatusIsAnsweredPerCallingAccount(): void {
    $editor = $this->createEditor();
    $viewer = $this->createEditor();
    $outsider = $this->createEditor();
    $space = $this->createSpace($editor, TRUE, [$viewer]);
    $this->createSpace($outsider, TRUE);
    $page = $this->createPage($editor->id(), 'published', $space, self::BLOCKS);
    $this->addForwardDraft($page, "Intro. {#b-one}\n\nDetail, rewritten. {#b-two}", $editor);

    $this->assertTrue($this->readStatus($page, $editor)['canPublish']);

    foreach (['a viewer' => $viewer, 'an editor of another space' => $outsider] as $who => $account) {
      $response = $this->request('/openkb/node/' . $page->id() . '/moderation', $account);
      $this->assertSame(403, $response->getStatusCode(), $who . ': ' . $response->getContent());
    }
  }

  /**
   * A user carrying exactly the recipe's authenticated grants.
   */
  private function createEditor(): AccountInterface {
    return $this->createUser($this->recipeGrantedPermissions('authenticated'));
  }

  /**
   * A space with the given moderation policy, its roster holding the editor.
   */
  private function createSpace(AccountInterface $editor, bool $moderated, array $viewers = []): SpaceInterface {
    $space = Space::create([
      'label' => $moderated ? 'Handbook' : 'Scratchpad',
      'read_access' => 'all_users',
      'field_moderation' => $moderated ? 1 : 0,
      'managers' => [['target_id' => $editor->id()]],
      'viewers' => array_map(
        static fn (AccountInterface $viewer): array => ['target_id' => $viewer->id()],
        $viewers,
      ),
    ]);
    $space->save();
    return $space;
  }

  /**
   * Builds a page in the given moderation state, seeded past validation.
   *
   * Direct ->save() skips entity validation, so seeding needs no transition
   * permission — the permissions under test are the reader's, not the
   * fixture's.
   *
   * The sidecar the seed's own presave stamped is cleared afterwards, so the
   * page stands for content that has already been through review and every
   * blocker downstream belongs to a write the test made.
   */
  private function createPage(string|int $uid, string $state, ?SpaceInterface $space = NULL, string $body = 'Body.'): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Moderation probe',
      'uid' => $uid,
      'moderation_state' => $state,
      'field_kb_body' => ['value' => $body, 'format' => 'comark'],
    ] + ($space ? ['field_space' => ['target_id' => $space->id()]] : []));
    $page->save();
    $page->set('field_block_meta', NULL);
    $page->setNewRevision(FALSE);
    $page->save();
    return $page;
  }

  /**
   * Adds a non-default draft revision on top of the published one.
   *
   * The writing account is named when the draft's blockers are the point:
   * presave credits the current user, so a draft written by nobody in
   * particular is flagged for nobody in particular.
   */
  private function addForwardDraft(NodeInterface $page, string $body = 'Draft body.', ?AccountInterface $writer = NULL): void {
    if ($writer !== NULL) {
      $this->setCurrentUser($writer);
    }
    $page->setNewRevision(TRUE);
    $page->set('moderation_state', 'draft');
    $page->set('field_kb_body', ['value' => $body, 'format' => 'comark']);
    $page->save();
  }

  /**
   * Signs one block off out of band, as a reviewer who did not write it.
   *
   * The commit endpoint is a POST, which this harness does not carry (see the
   * base class); what these cases need is the state a sign-off leaves, and the
   * model writes it. \Drupal\Tests\openkb_workflow\Functional\PublishGateTest
   * drives the endpoint itself.
   */
  private function signOff(NodeInterface $page, string $id, string $step, AccountInterface $reviewer): void {
    $latest = $this->workingCopy($page);
    $blocks = $this->pageBlocks()->decode($latest->get('field_block_meta')->value);
    $blocks[$id] = $this->pageBlocks()->approve(
      $blocks[$id],
      $step,
      (int) $reviewer->id(),
      $reviewer->getAccountName(),
      1000,
      (int) $latest->getRevisionId(),
    );
    $latest->set('field_block_meta', $this->pageBlocks()->encode($blocks));
    $latest->setNewRevision(FALSE);
    $latest->save();
  }

  /**
   * What holds one revision's publication up: block id => the steps it owes.
   *
   * `blocks_pending` is the size of exactly this, and it is asked of one
   * revision because the sidecar rides on the revision — which is why a
   * published read and a draft read of the same page can differ.
   */
  private function blockersOf(NodeInterface $revision, array $steps): array {
    return $this->pageBlocks()->blockers(
      $this->pageBlocks()->decode($revision->get('field_block_meta')->value),
      $steps,
    );
  }

  /**
   * The page's newest revision — the forward draft, where there is one.
   */
  private function workingCopy(NodeInterface $page): NodeInterface {
    $storage = $this->nodeStorage();
    return $storage->loadRevision($storage->getLatestRevisionId($page->id()));
  }

  /**
   * The page's default revision — what a published read projects.
   */
  private function defaultRevision(NodeInterface $page): NodeInterface {
    return $this->nodeStorage()->load($page->id());
  }

  /**
   * Node storage, past the static cache the test's own saves populated.
   */
  private function nodeStorage(): object {
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    return $storage;
  }

  /**
   * The block model, as the container wires it.
   */
  private function pageBlocks(): PageBlocks {
    return $this->container->get('openkb_workflow.page_blocks');
  }

  /**
   * Reads the status route as the given user.
   *
   * @return array
   *   The decoded status document.
   */
  private function readStatus(NodeInterface $page, AccountInterface $user): array {
    $response = $this->request('/openkb/node/' . $page->id() . '/moderation', $user);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    return $this->decode($response);
  }

}
