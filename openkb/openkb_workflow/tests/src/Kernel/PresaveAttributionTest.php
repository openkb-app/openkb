<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_workflow\Kernel;

use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Tests\openkb_agent\Traits\CollabClientTrait;
use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_workflow\PageBlocks;
use Drupal\openkb_space_access\SpaceAccessPolicy;

/**
 * What presave does to a page, asked of presave.
 *
 * These are properties of the attribution itself rather than of any surface
 * that triggers it: the flag rides in the same save as the content, an edit
 * landing after an approval makes the block pending again, and a block the
 * body no longer holds leaves nothing behind. A save is a save, so the
 * cheapest write that reaches presave — `->save()` — is the one that asks the
 * question, and there is no HTTP boundary to be the point.
 *
 * That every *write surface* produces these same facts is the other half, and
 * it needs the surfaces: see
 * \Drupal\Tests\openkb_workflow\Functional\WriteSurfaceAttributionTest.
 *
 * Test-matrix case 10 (an edit landing after an approval makes the block
 * pending again).
 *
 * @group openkb_workflow
 */
final class PresaveAttributionTest extends OpenkbRequestKernelTestBase {

  use CollabClientTrait;

  /**
   * The body a page is seeded with — two addressable blocks.
   */
  private const SEED = "One. {#b-one}\n\nTwo. {#b-two}";

  /**
   * {@inheritdoc}
   *
   * The `use collaboration api` permission the accounts here are granted is
   * openkb_collab_api's, and a kernel test resolves no info.yml dependency.
   */
  protected static $modules = [
    'openkb_schema',
    'openkb_collab_api',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbReviewConfigNames());
    // The recipe grants an authenticated user the editorial transitions, and a
    // permission cannot be granted before the workflow that defines it exists.
    $this->importRecipeConfig($this->kbModerationConfigNames());
    // Who a checkpoint is believed of is a scope, so the scope has to be here.
    $this->importRecipeConfig($this->collabClientConfigNames());
  }

  /**
   * The stamp rides in the same save as the content — never a second write.
   *
   * If flagging were a follow-up save, a crash between the two would publish
   * content nobody reviewed with no record that it needed reviewing.
   */
  public function testStampIsAtomicWithTheContent(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);
    $before = $this->revisionCount($page);

    $this->writeAs($editor, $page, "One. {#b-one}\n\nTwo, rewritten. {#b-two}");

    $this->assertSame($before + 1, $this->revisionCount($page));
    $latest = $this->reload($page);
    $this->assertStringContainsString('Two, rewritten.', (string) $latest->get('field_kb_body')->value);
    $this->assertTrue($this->pageBlocks()->isPending(
      $this->pageBlocks()->decode($latest->get('field_block_meta')->value)['b-two'],
      PageBlocks::STEP_PEER,
    ));
  }

  /**
   * Case 10: an edit landing after an approval makes the block pending again.
   *
   * The approval was given to text that has since moved, so it cannot go on
   * standing for the block — which is the whole reason the flag is re-stamped
   * on every write rather than derived from a comparison after the fact.
   */
  public function testEditAfterApprovalIsPendingAgain(): void {
    $editor = $this->createEditor();
    $reviewer = $this->createUser();
    $page = $this->createPage($editor, self::SEED);
    $this->writeAs($editor, $page, "One. {#b-one}\n\nTwo, rewritten. {#b-two}");

    // Sign it off out of band — the checkpoint that does this properly has its
    // own suite; what is under test here is what the NEXT write does.
    $latest = $this->reload($page);
    $sidecar = $this->pageBlocks()->decode($latest->get('field_block_meta')->value);
    $sidecar['b-two'] = $this->pageBlocks()->approve(
      $sidecar['b-two'],
      PageBlocks::STEP_PEER,
      (int) $reviewer->id(),
      $reviewer->getAccountName(),
      1000,
      (int) $latest->getRevisionId(),
    );
    $latest->set('field_block_meta', $this->pageBlocks()->encode($sidecar));
    $latest->setNewRevision(FALSE);
    $latest->save();
    $this->assertFalse($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));

    $this->writeAs($editor, $page, "One. {#b-one}\n\nTwo, rewritten once more. {#b-two}");

    $this->assertStringContainsString('once more', (string) $this->reload($page)->get('field_kb_body')->value);
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * A removed block keeps its record, marked, and owing a review (ADR 0017).
   *
   * Deleting a paragraph changes what the live page says as surely as
   * rewriting it does. The block is gone from the text the diff walks, so the
   * record is the only thing left to flag and the only thing a reviewer can be
   * shown.
   */
  public function testRemovedBlockKeepsRecordThatOwesReview(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    $this->writeAs($editor, $page, 'One. {#b-one}');

    $entry = $this->sidecar($page)['b-two'];
    $this->assertTrue($entry['deleted']);
    $this->assertTrue($this->pageBlocks()->isPending($entry, PageBlocks::STEP_PEER));
    $this->assertSame(
      [(int) $editor->id()],
      $this->pageBlocks()->contributorsSince($entry, PageBlocks::STEP_PEER),
    );
  }

  /**
   * The record retires once the live page has stopped showing the block too.
   *
   * It stands for a difference a reader can see. Once the live page agrees, it
   * describes nothing.
   */
  public function testRemovedBlockRecordRetiresOnceTheLivePageAgrees(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);
    $this->writeAs($editor, $page, 'One. {#b-one}');
    $this->assertArrayHasKey('b-two', $this->sidecar($page));

    // The removal is live now, so the next write has nothing to say about it.
    $this->writeAs($editor, $page, 'One, again. {#b-one}');

    $this->assertArrayNotHasKey('b-two', $this->sidecar($page));
  }

  /**
   * The mark comes off when the body holds the block again.
   *
   * A block put back is an ordinary block, so a record still calling it
   * deleted would have the reader shown a removed-block card for text that is
   * in the document.
   */
  public function testDeletedMarkComesOffWhenTheBlockIsBack(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    $this->writeAs($editor, $page, 'One. {#b-one}');
    $this->assertTrue($this->sidecar($page)['b-two']['deleted']);

    $this->writeAs($editor, $page, self::SEED);

    $entry = $this->sidecar($page)['b-two'];
    $this->assertArrayNotHasKey('deleted', $entry);
    $this->assertTrue($this->pageBlocks()->isPending($entry, PageBlocks::STEP_PEER));
  }

  /**
   * A difference an earlier draft save left behind still owes its review.
   *
   * The rule is the whole difference against the live page, and the block diff
   * only ever sees the save that made one. A draft carrying a removal no entry
   * speaks for would otherwise publish it unreviewed.
   */
  public function testDifferenceFromAnEarlierSaveStillOwesItsReview(): void {
    $author = $this->createEditor();
    $editor = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($author, self::SEED);

    // The live page keeps its record of the text about to be taken away.
    $live = $this->reload($page);
    $live->set('field_block_meta', $this->pageBlocks()->encode([
      'b-two' => $this->pageBlocks()->stamp([], (int) $author->id(), NULL, $author->getAccountName(), 1000),
    ]));
    $live->setNewRevision(FALSE);
    $live->save();

    // A draft that dropped the block and carries no entry for it: what a draft
    // written before this rule existed looks like.
    $this->draftAs($editor, $page, 'One. {#b-one}');
    $this->stripSidecar($page);
    $this->assertArrayNotHasKey('b-two', $this->draftSidecar($page));

    // The next save says nothing about the removal, and still owes it.
    $this->draftAs($editor, $page, 'One, edited elsewhere. {#b-one}');

    $entry = $this->draftSidecar($page)['b-two'];
    $this->assertTrue($entry['deleted']);
    $this->assertTrue($this->pageBlocks()->isPending($entry, PageBlocks::STEP_PEER));
    // Against the live record, so a colleague can clear it.
    $this->assertSame(
      [(int) $author->id()],
      $this->pageBlocks()->contributorsSince($entry, PageBlocks::STEP_PEER),
    );

    $held = $this->blockersOf($this->publishOf($this->latestRevision($page)));
    $this->assertArrayHasKey('b-two', $held);

    // Signed off by somebody who wrote none of it, the publish goes through.
    $signed = $this->latestRevision($page);
    $sidecar = $this->pageBlocks()->decode($signed->get('field_block_meta')->value);
    foreach (array_keys($held) as $item) {
      $sidecar[$item] = $this->pageBlocks()->approve(
        $sidecar[$item],
        PageBlocks::STEP_PEER,
        (int) $reviewer->id(),
        $reviewer->getAccountName(),
        1000,
        (int) $signed->getRevisionId(),
      );
    }
    $signed->set('field_block_meta', $this->pageBlocks()->encode($sidecar));
    $signed->setNewRevision(FALSE);
    $signed->save();

    $this->assertSame([], $this->blockersOf($this->publishOf($this->latestRevision($page))));
  }

  /**
   * A rename an earlier draft save left behind opens naming nobody.
   *
   * Nothing on record says who renamed the page, and a baseline that does not
   * say who made a change cannot be the one it is signed off against — so the
   * entry opens unaccounted and waits for an admin (ADR 0004, ADR 0002).
   */
  public function testRenameFromAnEarlierSaveOpensNamingNobody(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    $this->setCurrentUser($editor);
    $renamed = $this->latestRevision($page);
    $renamed->setTitle('A different name for the same text');
    $renamed->set('moderation_state', 'draft');
    $renamed->setNewRevision(TRUE);
    $renamed->save();
    $this->stripSidecar($page);
    $this->assertArrayNotHasKey(PageBlocks::FIELD_TITLE, $this->draftSidecar($page));

    $this->draftAs($editor, $page, "One, edited elsewhere. {#b-one}\n\nTwo. {#b-two}");

    $entry = $this->draftSidecar($page)[PageBlocks::FIELD_TITLE];
    $this->assertTrue($this->pageBlocks()->isPending($entry, PageBlocks::STEP_PEER));
    $this->assertSame([], $this->pageBlocks()->contributorsSince($entry, PageBlocks::STEP_PEER));
    $this->assertArrayHasKey(
      PageBlocks::FIELD_TITLE,
      $this->blockersOf($this->publishOf($this->latestRevision($page))),
    );
  }

  /**
   * A removal nobody is named for falls back to the record's contributors.
   *
   * An empty writer set is a hold a block gets out of, because the next
   * identified edit re-stamps it. A removed block has no text to edit, so the
   * accounts the record already names are the baseline instead — otherwise the
   * page waits for a sign-off nobody but an admin could ever give.
   */
  public function testRemovalNobodyIsNamedForFallsBackToItsContributors(): void {
    $writer = $this->createEditor();
    $server = $this->createCollabServer();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer, self::SEED);

    // b-two is on record as the writer's work.
    $this->writeAs($writer, $page, "One. {#b-one}\n\nTwo, by the writer. {#b-two}");

    // The checkpoint takes it out and says nothing about it.
    $this->carryCollabStatement(['blocks' => []]);
    $this->writeAs($server, $page, 'One. {#b-one}');

    $entry = $this->sidecar($page)['b-two'];
    $this->assertTrue($entry['deleted']);
    $this->assertSame(
      [(int) $writer->id()],
      $this->pageBlocks()->contributorsSince($entry, PageBlocks::STEP_PEER),
    );
    $this->assertFalse(
      $this->pageBlocks()->mayApprove($entry, PageBlocks::STEP_PEER, (int) $writer->id()),
      'The account that wrote what is gone is still not the second pair of eyes.',
    );
    $this->assertTrue(
      $this->pageBlocks()->mayApprove($entry, PageBlocks::STEP_PEER, (int) $reviewer->id()),
      'Somebody else can clear it.',
    );
  }

  /**
   * A rename nobody is named for falls back to the record's contributors.
   *
   * The fields lane states the title's writers, and a window that lost them
   * would otherwise leave the rename approvable by nobody.
   */
  public function testTitleChangeNobodyIsNamedForFallsBackToItsContributors(): void {
    $writer = $this->createEditor();
    $server = $this->createCollabServer();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer, self::SEED);

    $this->setCurrentUser($writer);
    $named = $this->reload($page);
    $named->setTitle('A name the writer gave it');
    $named->setNewRevision(TRUE);
    $named->save();

    // A second rename arrives with the fields lane saying nothing.
    $this->carryCollabStatement(['blocks' => []]);
    $this->setCurrentUser($server);
    $renamed = $this->reload($page);
    $renamed->setTitle('A name from a lost window');
    $renamed->setNewRevision(TRUE);
    $renamed->save();

    $entry = $this->sidecar($page)[PageBlocks::FIELD_TITLE];
    $this->assertSame(
      [(int) $writer->id()],
      $this->pageBlocks()->contributorsSince($entry, PageBlocks::STEP_PEER),
    );
    $this->assertTrue(
      $this->pageBlocks()->mayApprove($entry, PageBlocks::STEP_PEER, (int) $reviewer->id()),
    );
  }

  /**
   * A record naming nobody at all keeps the empty writer set (ADR 0004).
   *
   * The fallback answers from the record, so a block the sidecar never spoke
   * about has nothing to answer with, and nobody but an admin may clear it.
   */
  public function testRemovalOfBlockNoRecordNamesStaysApprovableByNobody(): void {
    $server = $this->createCollabServer();
    $reviewer = $this->createEditor();
    $page = $this->createPage($server, self::SEED);

    $this->carryCollabStatement(['blocks' => []]);
    $this->writeAs($server, $page, 'One. {#b-one}');

    $entry = $this->sidecar($page)['b-two'];
    $this->assertSame([], $this->pageBlocks()->contributorsSince($entry, PageBlocks::STEP_PEER));
    $this->assertFalse(
      $this->pageBlocks()->mayApprove($entry, PageBlocks::STEP_PEER, (int) $reviewer->id()),
    );
    $this->assertTrue(
      $this->pageBlocks()->mayApprove($entry, PageBlocks::STEP_PEER, (int) $reviewer->id(), TRUE),
      'An admin clears it, as ADR 0002 says.',
    );
  }

  /**
   * The title is reviewed like a block, under its own entry (ADR 0017).
   */
  public function testTitleChangeTakesReviewEntry(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);
    $this->assertArrayNotHasKey(PageBlocks::FIELD_TITLE, $this->sidecar($page));

    $this->setCurrentUser($editor);
    $latest = $this->reload($page);
    $latest->setTitle('A different name for the same text');
    $latest->setNewRevision(TRUE);
    $latest->save();

    $entry = $this->sidecar($page)[PageBlocks::FIELD_TITLE];
    $this->assertTrue($this->pageBlocks()->isPending($entry, PageBlocks::STEP_PEER));
    $this->assertSame(
      [(int) $editor->id()],
      $this->pageBlocks()->contributorsSince($entry, PageBlocks::STEP_PEER),
    );
  }

  /**
   * A collaborative checkpoint records the window it carries.
   *
   * The write is one request carrying several peers' keystrokes under whichever
   * of them authenticated last. Crediting that one books somebody else's
   * paragraph to them AND leaves the real writer uncredited — an outsider to
   * the four-eyes rule, free to sign off their own change. So the checkpoint
   * states who wrote what itself, and presave records it in the save that
   * writes the text.
   */
  public function testSessionCheckpointRecordsWhoWroteWhat(): void {
    $editor = $this->createCollabServer();
    $other = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    $this->carryCollabStatement([
      'blocks' => ['b-two' => [['uid' => (int) $other->id(), 'via' => NULL]]],
    ]);
    $this->writeAs($editor, $page, "One. {#b-one}\n\nTwo, rewritten. {#b-two}");

    $block = $this->sidecar($page)['b-two'];
    $this->assertTrue(
      $this->pageBlocks()->isPending($block, PageBlocks::STEP_PEER),
      'The flag is a fact about the block and is stamped whoever typed.',
    );
    $this->assertSame(
      [(int) $other->id()],
      array_column($block['contributors'], 'uid'),
      'The peer who wrote it is named — not the one whose cookie carried it.',
    );
    $this->assertSame(
      [(int) $other->id()],
      $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER),
      'And the four-eyes baseline is theirs, opened by the same save.',
    );
  }

  /**
   * A changed block the window names nobody for is stamped for NOBODY.
   *
   * The collaboration server books every block whose content moves, so what its
   * map does not name is not one of the session's peers' work at all — it is
   * text left in a document by a window whose accounting was lost before any
   * write carried it (a failed final checkpoint, a revoked carrier, a restart).
   * Naming the peers who happen to be in the room now would put the four-eyes
   * baseline on bystanders and leave the real author free to sign it off.
   * Naming nobody is refused for everybody, which is the safe reading.
   */
  public function testUnaccountedChangeNamesNobody(): void {
    $editor = $this->createCollabServer();
    $other = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    // The window carries writing on b-one only; b-two moved without anybody
    // here accounting for it.
    $this->carryCollabStatement([
      'blocks' => ['b-one' => [['uid' => (int) $other->id(), 'via' => NULL]]],
    ]);
    $this->writeAs($editor, $page, "One, more. {#b-one}\n\nTwo, from a lost window. {#b-two}");

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame([], $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER));
    $this->assertSame([], $block['contributors'] ?? []);
    foreach ([$editor, $other] as $account) {
      $this->assertFalse(
        $this->pageBlocks()->mayApprove($block, PageBlocks::STEP_PEER, (int) $account->id()),
        'Nobody may sign off writing this server cannot attribute.',
      );
    }
  }

  /**
   * An open episode does not survive an unaccounted change to its block.
   *
   * The state the empty baseline has to reach to be worth anything. A block is
   * normally open under whoever last edited it, and the writing whose
   * accounting was lost lands on top of that: one editor's own edit, then a
   * second peer's surviving text arriving with nothing to name it. An episode
   * that kept the first editor's name would be non-empty — an ordinary episode
   * to the rule, excluding the peer who wrote what is now on the page, and
   * approvable by the editor who did not.
   */
  public function testUnaccountedChangePoisonsTheEpisodeAlreadyOpen(): void {
    $editor = $this->createEditor();
    $other = $this->createEditor();
    $server = $this->createCollabServer();
    $page = $this->createPage($editor, self::SEED);

    // The editor's own edit opens b-two's episode in their name.
    $this->writeAs($editor, $page, "One. {#b-one}\n\nTwo, by the editor. {#b-two}");
    $this->assertSame(
      [(int) $editor->id()],
      $this->pageBlocks()->contributorsSince($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER),
    );

    // The next session commits the other peer's surviving text with nothing
    // accounting for it.
    $this->carryCollabStatement(['blocks' => []]);
    $this->writeAs($server, $page, "One. {#b-one}\n\nTwo, from a lost window. {#b-two}");

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame([], $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER));
    foreach ([$editor, $other, $server] as $account) {
      $this->assertFalse(
        $this->pageBlocks()->mayApprove($block, PageBlocks::STEP_PEER, (int) $account->id()),
        'Not the earlier author, and not anybody else.',
      );
    }
  }

  /**
   * The window is recorded for the blocks it names, changed bytes or not.
   *
   * A window stays owed until a write carries it, and by the time one does,
   * another path may already have stored the very text it accounts for — an
   * agent committing the shared document under its own token, above all. The
   * byte diff is then silent about those blocks, and the peers who typed them
   * would never reach the four-eyes baseline: each an outsider to their own
   * paragraph, free to approve it.
   *
   * The characters are NOT credited again: they are already booked to whoever
   * carried the bytes there, and the same window may arrive twice — a PATCH
   * whose response was lost landed all the same. So the peer is recorded as
   * having touched the block, which is what the rule reads, at no characters.
   */
  public function testWindowIsRecordedForBlocksTheDiffIsSilentAbout(): void {
    $editor = $this->createCollabServer();
    $other = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    // b-two's text is already in Drupal; only b-one moves in this write.
    $this->carryCollabStatement([
      'blocks' => ['b-two' => [['uid' => (int) $other->id(), 'via' => NULL]]],
    ]);
    $this->writeAs($editor, $page, "One, more. {#b-one}\n\nTwo. {#b-two}");

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame(
      [(int) $other->id()],
      $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER),
      'The peer who typed it reaches the four-eyes baseline, so they cannot sign it off.',
    );
    $this->assertFalse(
      $this->pageBlocks()->mayApprove($block, PageBlocks::STEP_PEER, (int) $other->id()),
    );
    $this->assertSame(
      [(int) $other->id()],
      array_column($block['contributors'], 'uid'),
      'Named in the byline for writing the write that stored the bytes carried.',
    );
  }

  /**
   * A window carried onto text it did not change keeps that text's approvals.
   *
   * The re-delivery case, and the reason it matters: a checkpoint whose
   * response is lost has landed, so the collaboration server re-sends a window
   * Drupal already applied. It arrives on bytes that have not moved since —
   * and a sign-off given to those bytes is a review of exactly what is still
   * there. Voiding it on every retry makes the approval record say something
   * nobody did.
   */
  public function testCarriedWindowKeepsApprovalsOnTextItLeftAlone(): void {
    $editor = $this->createCollabServer();
    $other = $this->createEditor();
    $reviewer = $this->createUser();
    $page = $this->createPage($editor, self::SEED);

    // The window lands once, on the write that changes b-two.
    $window = ['blocks' => ['b-two' => [['uid' => (int) $other->id(), 'via' => NULL]]]];
    $this->carryCollabStatement($window);
    $this->writeAs($editor, $page, "One. {#b-one}\n\nTwo, from the session. {#b-two}");

    // Signed off out of band, against the text that write stored.
    $latest = $this->reload($page);
    $sidecar = $this->pageBlocks()->decode($latest->get('field_block_meta')->value);
    $sidecar['b-two'] = $this->pageBlocks()->approve(
      $sidecar['b-two'],
      PageBlocks::STEP_PEER,
      (int) $reviewer->id(),
      $reviewer->getAccountName(),
      1000,
      (int) $latest->getRevisionId(),
    );
    $latest->set('field_block_meta', $this->pageBlocks()->encode($sidecar));
    $latest->setNewRevision(FALSE);
    $latest->save();
    $this->assertFalse($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));

    // The same window again, on a write that leaves b-two's bytes alone.
    $this->carryCollabStatement($window);
    $this->writeAs($editor, $page, "One, edited. {#b-one}\n\nTwo, from the session. {#b-two}");

    $block = $this->sidecar($page)['b-two'];
    $this->assertFalse(
      $this->pageBlocks()->isPending($block, PageBlocks::STEP_PEER),
      'The sign-off still covers text this write did not touch.',
    );
    $this->assertSame(
      [(int) $other->id()],
      array_column($block['contributors'], 'uid'),
      'Carried onto the block without re-opening its settled step.',
    );
  }

  /**
   * A block id that is all digits is a block id like any other.
   *
   * JSON turns the object key "2024" into an int on the way in, and a map that
   * quietly drops it credits nobody for that block — which reads to the
   * four-eyes rule as writing this server could not attribute, on a block
   * somebody did write. Hand-authored and agent-written markdown both produce
   * ids like it.
   */
  public function testNumericBlockIdIsCredited(): void {
    $editor = $this->createCollabServer();
    $other = $this->createEditor();
    $page = $this->createPage($editor, "One. {#2024}");

    $this->carryCollabStatement([
      'blocks' => ['2024' => [['uid' => (int) $other->id(), 'via' => NULL]]],
    ]);
    $this->writeAs($editor, $page, "One, rewritten. {#2024}");

    $block = $this->sidecar($page)['2024'];
    $this->assertSame(
      [(int) $other->id()],
      array_column($block['contributors'], 'uid'),
    );
    $this->assertSame(
      [(int) $other->id()],
      $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER),
    );
  }

  /**
   * A write stating no window credits its writer, believed or not.
   *
   * Every other path — the node form, a JSON:API PATCH, an agent's block write,
   * a peer's own Save — is one account writing, and that account is answerable
   * for it. The collaboration server's own account included: holding the
   * permission is not checkpointing, and reading a plain save as a window that
   * witnessed nobody would leave every block it touched approvable by nobody.
   *
   * It is credited the characters as well as the block, which is the half a
   * checkpoint does NOT do: a stated set is membership only and books no
   * amount (ADR 0002), as the carried-window cases below pin. So the same
   * typing reaching Drupal twice — once carried by its writer, once accounted
   * for by the server — is counted once.
   */
  public function testDirectWriteStillCreditsItsWriter(): void {
    $editor = $this->createCollabServer();
    $page = $this->createPage($editor, self::SEED);

    $this->writeAs($editor, $page, "One. {#b-one}\n\nTwo, rewritten. {#b-two}");

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame(
      [(int) $editor->id()],
      array_map(static fn (array $c): int => (int) $c['uid'], $block['contributors'] ?? []),
    );
    $this->assertSame(
      [(int) $editor->id()],
      $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER),
    );
    $this->assertSame((int) $editor->id(), (int) $block['contributors'][0]['uid']);
  }

  /**
   * The same statement off the collaboration connection buys nothing.
   *
   * The case that makes the identity load-bearing. An account holding every
   * permission there is — uid 1, a site administrator — sends byte-for-byte
   * what a checkpoint sends, over a session rather than the client's token.
   * Both halves of a checkpoint are refused it: it cannot write somebody else
   * into a block's baseline, and it cannot empty one either. "Credit nobody"
   * is what makes a writer an outsider to the four-eyes rule, so a payload
   * that could declare it is the bypass the model exists to prevent.
   */
  public function testTheSameStatementOffTheConnectionBuysNothing(): void {
    $admin = $this->createUser([], NULL, TRUE);
    $other = $this->createEditor();
    $page = $this->createPage($admin, self::SEED);

    $this->carryCollabStatement([
      'blocks' => ['b-two' => [['uid' => (int) $other->id(), 'via' => NULL]]],
    ]);
    $this->writeAs($admin, $page, "One. {#b-one}\n\nTwo, rewritten. {#b-two}");

    $this->assertSame(
      [(int) $admin->id()],
      $this->pageBlocks()->contributorsSince(
        $this->sidecar($page)['b-two'],
        PageBlocks::STEP_PEER,
      ),
      'The writer is credited, and the account they named is not.',
    );

    // And the shape an admin's ordinary save actually has — a window naming
    // nobody — leaves the block theirs rather than unaccounted.
    $this->carryCollabStatement(['blocks' => []]);
    $this->writeAs($admin, $page, "One. {#b-one}\n\nTwo, rewritten again. {#b-two}");

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame(
      [(int) $admin->id()],
      $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER),
      'Never unaccounted: the author is standing right there in the credential.',
    );
  }

  /**
   * A programmatic save is trusted: seeds and migrations publish untouched.
   *
   * The gate lives in validation (wire) and on the commit routes; an internal
   * `$node->save()` that skips validation must be neither refused nor
   * diverted, or every recipe import would silently draft its own content.
   */
  public function testProgrammaticSaveIsNeverHeldOrRefused(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    // The write re-stamps b-two pending, and the save stays published.
    $this->writeAs($editor, $page, "One. {#b-one}\n\nTwo, rewritten. {#b-two}");

    $reloaded = $this->reload($page);
    $this->assertSame('published', (string) $reloaded->get('moderation_state')->value);
    $this->assertTrue($reloaded->isDefaultRevision());
    $this->assertStringContainsString('Two, rewritten.', (string) $reloaded->get('field_kb_body')->value);
  }

  /**
   * Validation refuses the same write a wire surface would deliver.
   *
   * JSON:API validates every write, so this violation is the 422 a raw PATCH
   * gets when it would publish a block still awaiting review (ADR 0004).
   */
  public function testValidationRefusesPublishingUnderReview(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    $this->setCurrentUser($editor);
    $latest = $this->reload($page);
    $latest->set('field_kb_body', ['value' => "One. {#b-one}\n\nTwo, rewritten. {#b-two}", 'format' => 'comark']);
    $latest->setNewRevision(TRUE);

    $violations = $latest->validate();
    $messages = [];
    foreach ($violations as $violation) {
      $messages[] = (string) $violation->getMessage();
    }
    $this->assertNotEmpty(
      array_filter($messages, fn (string $m): bool => str_contains($m, 'await review')),
      'the publish gate refused: ' . implode(' | ', $messages),
    );

    // A state-only save carries no content change: our gate stays silent
    // (whatever else core validation may have to say).
    $stateOnly = $this->reload($page);
    $stateOnly->setNewRevision(TRUE);
    $quiet = array_filter(
      iterator_to_array($stateOnly->validate()),
      fn ($v): bool => str_contains((string) $v->getMessage(), 'await review'),
    );
    $this->assertCount(0, $quiet);
  }

  /**
   * Taking a block out cannot publish itself past the gate (ADR 0017).
   *
   * The new body carries nothing of the deletion, so the record the removal
   * leaves on the sidecar is the only thing the gate can read it from.
   */
  public function testValidationRefusesPublishingRemovedBlock(): void {
    $this->assertRefusesToPublish(function (NodeInterface $publish): void {
      $publish->set('field_kb_body', ['value' => 'One. {#b-one}', 'format' => 'comark']);
    });
  }

  /**
   * A title edit cannot publish itself past the gate (ADR 0017).
   */
  public function testValidationRefusesPublishingTitleChange(): void {
    $this->assertRefusesToPublish(function (NodeInterface $publish): void {
      $publish->setTitle('A different name for the same text');
    });
  }

  /**
   * Reordering blocks cannot publish itself past the gate (ADR 0017).
   */
  public function testValidationRefusesPublishingReorder(): void {
    $this->assertRefusesToPublish(function (NodeInterface $publish): void {
      $publish->set('field_kb_body', [
        'value' => "Two. {#b-two}\n\nOne. {#b-one}",
        'format' => 'comark',
      ]);
    });
  }

  /**
   * A block a session only moved is the saver's, and a peer clears it.
   *
   * The collaboration window books writing, and a move writes nothing: it
   * names nobody for the block, and an item naming nobody is approvable by
   * nobody. The account the checkpoint acts as made the move, so it is the
   * one answerable for it.
   */
  public function testSessionReorderNamesTheSaver(): void {
    $saver = $this->createCollabServer();
    $reviewer = $this->createEditor();
    $page = $this->createPage($saver, self::SEED);

    $this->carryCollabStatement(['blocks' => []]);
    $this->draftAs($saver, $page, "Two. {#b-two}\n\nOne. {#b-one}");

    $held = $this->blockersOf($this->publishOf($page));
    $this->assertNotEmpty($held, 'the gate holds the move');

    $blocks = $this->pageBlocks();
    $sidecar = $this->draftSidecar($page);
    foreach (array_keys($held) as $item) {
      $this->assertSame(
        [(int) $saver->id()],
        $blocks->contributorsSince($sidecar[$item], PageBlocks::STEP_PEER),
        'the moved block names the account that saved the move',
      );
      $this->assertTrue($sidecar[$item]['moved'] ?? FALSE, 'the entry says the difference is a move');
      $this->assertFalse(
        $blocks->mayApprove($sidecar[$item], PageBlocks::STEP_PEER, (int) $saver->id()),
        'the saver may not clear their own move',
      );
      $this->assertTrue(
        $blocks->mayApprove($sidecar[$item], PageBlocks::STEP_PEER, (int) $reviewer->id()),
        'a peer may',
      );
      $sidecar[$item] = $blocks->approve(
        $sidecar[$item],
        PageBlocks::STEP_PEER,
        (int) $reviewer->id(),
        $reviewer->getAccountName(),
        1000,
        (int) $this->latestRevision($page)->getRevisionId(),
      );
    }

    $signed = $this->latestRevision($page);
    $signed->set('field_block_meta', $blocks->encode($sidecar));
    $signed->setNewRevision(FALSE);
    $signed->save();

    $this->assertSame([], $this->blockersOf($this->publishOf($page)));
  }

  /**
   * A publishing write carrying `$change` is refused; a second pair clears it.
   *
   * The two halves of one rule: the difference is held, and it is held by
   * something a reviewer can actually sign off — a gate nobody can clear is a
   * wedged page, not a review. The change is drafted first, so the live
   * page still disagrees with it while the publish is judged.
   *
   * @param callable(\Drupal\node\NodeInterface): void $change
   *   Applies the difference to the draft.
   */
  private function assertRefusesToPublish(callable $change): void {
    $editor = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    $this->setCurrentUser($editor);
    $draft = $this->reload($page);
    $change($draft);
    $draft->set('moderation_state', 'draft');
    $draft->setNewRevision(TRUE);
    $draft->save();

    $held = $this->blockersOf($this->publishOf($draft));
    $this->assertNotEmpty($held, 'the gate holds the change');

    // Signed off by somebody who did not write it, the same publish goes
    // through. Every item, because the gate names them all.
    $signed = $this->latestRevision($draft);
    $sidecar = $this->pageBlocks()->decode($signed->get('field_block_meta')->value);
    foreach (array_keys($held) as $item) {
      $sidecar[$item] = $this->pageBlocks()->approve(
        $sidecar[$item],
        PageBlocks::STEP_PEER,
        (int) $reviewer->id(),
        $reviewer->getAccountName(),
        1000,
        (int) $signed->getRevisionId(),
      );
    }
    $signed->set('field_block_meta', $this->pageBlocks()->encode($sidecar));
    $signed->setNewRevision(FALSE);
    $signed->save();

    $this->assertSame([], $this->blockersOf($this->publishOf($draft)));
  }

  /**
   * The draft's revision, loaded fresh and set to publish.
   */
  private function publishOf(NodeInterface $draft): NodeInterface {
    $publish = $this->latestRevision($draft);
    $publish->set('moderation_state', 'published');
    $publish->setNewRevision(TRUE);
    return $publish;
  }

  /**
   * One revision of a page, read past anything this request holds.
   */
  private function latestRevision(NodeInterface $revision): NodeInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    /** @var \Drupal\node\NodeInterface $loaded */
    $loaded = $storage->loadRevision($storage->getLatestRevisionId((int) $revision->id()));
    return $loaded;
  }

  /**
   * What the publish gate holds against this revision, by review item.
   *
   * @return array<string, string[]>
   *   Review item => the steps it owes.
   */
  private function blockersOf(NodeInterface $revision): array {
    return $this->container->get('openkb_workflow.block_attribution')->publicationHold($revision);
  }

  /**
   * A creation cannot publish itself past the gate on any validated surface.
   */
  public function testValidationRefusesPublishedCreationUnderReview(): void {
    $editor = $this->createEditor();
    $this->setCurrentUser($editor);
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Self-publishing creation',
      'uid' => $editor->id(),
      'moderation_state' => 'published',
      'field_kb_body' => ['value' => self::SEED, 'format' => 'comark'],
    ]);

    $messages = array_map(fn ($v): string => (string) $v->getMessage(), iterator_to_array($page->validate()));
    $this->assertNotEmpty(
      array_filter($messages, fn (string $m): bool => str_contains($m, 'await review')),
      'a published creation with unreviewed blocks is refused: ' . implode(' | ', $messages),
    );

    // The same creation as a draft passes — creation flows make drafts.
    $page->set('moderation_state', 'draft');
    $quiet = array_filter(
      array_map(fn ($v): string => (string) $v->getMessage(), iterator_to_array($page->validate())),
      fn (string $m): bool => str_contains($m, 'await review'),
    );
    $this->assertCount(0, $quiet);
  }

  /**
   * Publishing a draft-default page state-only is a publication event.
   *
   * The state change IS the publication: exempting it because no content
   * moved would let anyone publish never-reviewed text with a two-field
   * PATCH. The commit route refuses the same act with its 422.
   */
  public function testValidationRefusesStateOnlyPublishOfDraftDefault(): void {
    $editor = $this->createEditor();
    $this->setCurrentUser($editor);
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Draft-default page',
      'uid' => $editor->id(),
      'moderation_state' => 'draft',
      'field_kb_body' => ['value' => self::SEED, 'format' => 'comark'],
    ]);
    $page->save();

    $publish = $this->reload($page);
    $publish->set('moderation_state', 'published');
    $publish->setNewRevision(TRUE);

    $messages = array_map(fn ($v): string => (string) $v->getMessage(), iterator_to_array($publish->validate()));
    $this->assertNotEmpty(
      array_filter($messages, fn (string $m): bool => str_contains($m, 'await review')),
      'the state-only publish answers for its pending blocks: ' . implode(' | ', $messages),
    );
  }

  /**
   * Publishing a pending forward draft answers for the draft's blocks.
   *
   * The exemption diffs against the STORED DEFAULT: diffing against the
   * draft itself would read its publish as "no change on a live page".
   */
  public function testValidationRefusesPublishingThePendingForwardDraft(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    // A forward draft whose rewrite is pending review.
    $this->setCurrentUser($editor);
    $draft = $this->reload($page);
    $draft->set('field_kb_body', ['value' => "One. {#b-one}\n\nTwo, rewritten. {#b-two}", 'format' => 'comark']);
    $draft->set('moderation_state', 'draft');
    $draft->setNewRevision(TRUE);
    $draft->save();

    // Publishing that draft state-only is a publication of ITS content.
    $publish = $this->container->get('entity_type.manager')->getStorage('node')
      ->loadRevision($draft->getRevisionId());
    $publish->set('moderation_state', 'published');
    $publish->setNewRevision(TRUE);

    $messages = array_map(fn ($v): string => (string) $v->getMessage(), iterator_to_array($publish->validate()));
    $this->assertNotEmpty(
      array_filter($messages, fn (string $m): bool => str_contains($m, 'await review')),
      'the forward-draft publish answers for its blocks: ' . implode(' | ', $messages),
    );
  }

  /**
   * Changed text outside identified blocks blocks publication as itself.
   *
   * Stripping the ids off a body must not become a review bypass: the gate
   * cannot flag what it cannot address, so it refuses structurally.
   */
  public function testIdLessRewriteBlocksPublication(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor, self::SEED);

    $this->setCurrentUser($editor);
    $publish = $this->reload($page);
    $publish->set('field_kb_body', ['value' => 'A rewrite carrying no ids at all.', 'format' => 'comark']);
    $publish->setNewRevision(TRUE);

    $messages = array_map(fn ($v): string => (string) $v->getMessage(), iterator_to_array($publish->validate()));
    $this->assertNotEmpty(
      array_filter($messages, fn (string $m): bool => str_contains($m, 'identified blocks')),
      'the id-less rewrite is refused: ' . implode(' | ', $messages),
    );
  }

  /**
   * A rename re-asks the structural refusal of a live body with id-less text.
   *
   * A title change is a publication event, so the whole of the gate answers
   * for the write — the body it would publish included. A page whose live
   * text cannot be addressed has no review lane, whatever the change was
   * (ADR 0004).
   */
  public function testRenameMeetsTheStructuralRefusalOfIdLessLiveText(): void {
    $editor = $this->createEditor();
    $this->setCurrentUser($editor);
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Seeded past the gate',
      'uid' => $editor->id(),
      'moderation_state' => 'published',
      'field_kb_body' => ['value' => 'Live text carrying no id.', 'format' => 'comark'],
    ]);
    $page->setSyncing(TRUE);
    $page->save();

    $renamed = $this->reload($page);
    $renamed->setTitle('A different name for the same text');
    $renamed->setNewRevision(TRUE);

    $messages = array_map(fn ($v): string => (string) $v->getMessage(), iterator_to_array($renamed->validate()));
    $this->assertNotEmpty(
      array_filter($messages, fn (string $m): bool => str_contains($m, 'identified blocks')),
      'the rename is refused: ' . implode(' | ', $messages),
    );
  }

  /**
   * Puts the collaboration server's checkpoint on the current request.
   *
   * On the request the kernel already carries rather than a pushed one: the
   * statement is a property of the request being made, and a substitute
   * request would leave the rest of the harness reading a different one. It
   * rides the body, exactly as the commit route receives it, so what is read
   * here is what a checkpoint actually sends.
   *
   * @param array $session
   *   The checkpoint's session directives.
   */
  private function carryCollabStatement(array $session = []): void {
    $request = $this->container->get('request_stack')->getCurrentRequest();
    if ($request === NULL) {
      return;
    }
    // A Symfony request's content is not settable, and re-initializing it is
    // what a body arriving on it looks like from the inside.
    $request->initialize(
      $request->query->all(),
      $request->request->all(),
      $request->attributes->all(),
      $request->cookies->all(),
      $request->files->all(),
      $request->server->all(),
      Json::encode(['session' => $session]),
    );
  }

  /**
   * An account holding what the recipe grants an authenticated user.
   */
  private function createEditor(): AccountInterface {
    return $this->createUser($this->recipeGrantedPermissions('authenticated'));
  }

  /**
   * The collaboration server, reaching Drupal over its own connection.
   *
   * The account behind it is an ordinary editor with the collaboration API
   * permission — access, and nothing more. What makes its statement worth
   * reading is the token's `collab` scope, which is what the returned account
   * carries (ADR 0001).
   */
  private function createCollabServer(): AccountInterface {
    return $this->onOauthConnection($this->createUser([
      ...$this->recipeGrantedPermissions('authenticated'),
      SpaceAccessPolicy::COLLABORATION,
    ]));
  }

  /**
   * A settled page: seeded, then its seed flags cleared.
   *
   * Presave runs on the seed like on any write and flags its blocks. Clearing
   * them leaves a page standing for content that has already been through
   * review, so every assertion downstream is about the write the test makes.
   */
  private function createPage(AccountInterface $owner, string $body): NodeInterface {
    $this->setCurrentUser($owner);
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Collab page',
      'uid' => $owner->id(),
      'moderation_state' => 'published',
      'field_kb_body' => ['value' => $body, 'format' => 'comark'],
    ]);
    $page->save();
    $page->set('field_block_meta', NULL);
    $page->setNewRevision(FALSE);
    $page->save();
    return $page;
  }

  /**
   * Writes a new body as a new revision — the shape every editing path saves.
   *
   * The acting account is named per write because that is what presave credits
   * (\Drupal\openkb_agent\ActingIdentity reads the current user), so a suite
   * that leaves it implicit can silently attribute a write to whoever it made
   * an account for last.
   */
  private function writeAs(AccountInterface $account, NodeInterface $page, string $body): void {
    $this->setCurrentUser($account);
    $latest = $this->reload($page);
    $latest->set('field_kb_body', ['value' => $body, 'format' => 'comark']);
    $latest->setNewRevision(TRUE);
    $latest->save();
  }

  /**
   * Writes a new body as a forward draft, leaving the live page where it is.
   */
  private function draftAs(AccountInterface $account, NodeInterface $page, string $body): void {
    $this->setCurrentUser($account);
    $draft = $this->latestRevision($page);
    $draft->set('field_kb_body', ['value' => $body, 'format' => 'comark']);
    $draft->set('moderation_state', 'draft');
    $draft->setNewRevision(TRUE);
    $draft->save();
  }

  /**
   * Empties the latest revision's sidecar without going through attribution.
   *
   * A syncing save is nobody's edit, so presave leaves the field alone: the
   * page is left standing for a difference no entry speaks for, which is
   * what a draft written before this rule existed looks like.
   */
  private function stripSidecar(NodeInterface $page): void {
    $revision = $this->latestRevision($page);
    $revision->set('field_block_meta', NULL);
    $revision->setSyncing(TRUE);
    $revision->setNewRevision(FALSE);
    $revision->save();
  }

  /**
   * The review sidecar of the latest revision, draft or not.
   *
   * @return array<string, array>
   *   Review item => its sidecar entry.
   */
  private function draftSidecar(NodeInterface $page): array {
    return $this->pageBlocks()->decode(
      $this->latestRevision($page)->get('field_block_meta')->value,
    );
  }

  /**
   * The page as storage now holds it.
   *
   * A programmatic save is never diverted by the publish gate (the
   * OkbPendingReview constraint fires only on validated writes), so the
   * default revision carries what a write just did.
   */
  private function reload(NodeInterface $page): NodeInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    /** @var \Drupal\node\NodeInterface $reloaded */
    $reloaded = $storage->load($page->id());
    return $reloaded;
  }

  /**
   * The stored review sidecar.
   *
   * @return array<string, array>
   *   Block id => the block's sidecar entry.
   */
  private function sidecar(NodeInterface $page): array {
    return $this->pageBlocks()->decode($this->reload($page)->get('field_block_meta')->value);
  }

  /**
   * How many revisions the page has.
   */
  private function revisionCount(NodeInterface $page): int {
    return count($this->container->get('entity_type.manager')->getStorage('node')->getQuery()
      ->accessCheck(FALSE)
      ->allRevisions()
      ->condition('nid', $page->id())
      ->execute());
  }

  /**
   * The block model, as the site wires it.
   */
  private function pageBlocks(): PageBlocks {
    return $this->container->get('openkb_workflow.page_blocks');
  }

}
