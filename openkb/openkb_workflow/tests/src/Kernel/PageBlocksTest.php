<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_workflow\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_workflow\PageBlocks;

/**
 * The block model every review surface is built on.
 *
 * Segmentation and the per-block rules are covered here, once, so the surfaces
 * that consume them — presave attribution, the commit endpoint, the publish
 * gate — can be tested for what they add rather than for the rules underneath.
 *
 * Every rule below is a pure function of its arguments: the service holds no
 * state and reads no storage. It is resolved from the container all the same,
 * so what the suite exercises is the object the site actually wires up.
 *
 * @group openkb_workflow
 */
final class PageBlocksTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'filter',
    'text',
    'node',
    'options',
    'taxonomy',
    'serialization',
    // The module's commit resource inherits jsonapi.entity_resource, so the
    // container does not compile without jsonapi — which in turn autowires a
    // file upload handler, so file comes with it.
    'file',
    'jsonapi',
    'path',
    'path_alias',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_space_access',
    'openkb_agent',
    'openkb_workflow',
  ];

  /**
   * The block model under test.
   */
  private PageBlocks $blocks;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->blocks = $this->container->get('openkb_workflow.page_blocks');
  }

  /**
   * One writer record in a session window's writer set (ADR 0002).
   *
   * Membership only — a session statement carries no per-block character count.
   */
  private function w(int $uid, ?string $via, string $name): array {
    return ['uid' => $uid, 'via' => $via, 'name' => $name];
  }

  /**
   * The service is the one the container wires, not one the test built.
   */
  public function testTheContainerServesTheBlockModel(): void {
    $this->assertInstanceOf(PageBlocks::class, $this->blocks);
    $this->assertSame($this->blocks, $this->container->get('openkb_workflow.page_blocks'));
  }

  /**
   * A body divides into the blocks that carry an id, and nothing else.
   */
  public function testSegmentsIdentifiedBlocks(): void {
    $body = <<<'MD'
    ## Section {#b-h}

    First paragraph. {#b-one}

    A paragraph nobody has touched yet.

    ::callout{type="info" #b-c}
    Inside the fence.

    Still inside, past a blank line.
    ::

    Second paragraph. {#b-two}
    MD;

    $blocks = $this->blocks->segment($body);

    $this->assertSame(['b-h', 'b-one', 'b-c', 'b-two'], array_keys($blocks));
    $this->assertSame('First paragraph. {#b-one}', $blocks['b-one']);
    $this->assertStringContainsString('Still inside, past a blank line.', $blocks['b-c']);
  }

  /**
   * A block's version is the same string on both sides of the wire.
   *
   * A citation stores the version of the block it was made against
   * (`frontend/shared/utils/citations.ts`), and the editor derives that
   * version with `blockVersion()` while a read here derives it with
   * `version()`. The two hash the same bytes, so the same body has to answer
   * the same three versions in both places —
   * `frontend/shared/utils/citations.test.ts` asserts these same literals.
   */
  public function testVersionsAgreeWithTheEditor(): void {
    $body = <<<'MD'
    ## Why the sky is blue {#b-sky}

    Rayleigh scattering sends short wavelengths in every direction. {#b-ray}

    ::callout{type="info" #b-note}
    Sunsets are the same effect at a longer path length.
    ::
    MD;

    $this->assertSame([
      'b-sky' => 'f3abb315b802',
      'b-ray' => 'e0ff367d5ce8',
      'b-note' => '2b6cb608ee32',
    ], $this->blocks->versions($body));
  }

  /**
   * A version moves with the block's own text and with nothing else.
   */
  public function testVersionsFollowTheBlockTheyAreOf(): void {
    $before = $this->blocks->versions("One. {#b-1}\n\nTwo. {#b-2}");
    $after = $this->blocks->versions("One, edited. {#b-1}\n\nTwo. {#b-2}");

    $this->assertNotSame($before['b-1'], $after['b-1']);
    $this->assertSame($before['b-2'], $after['b-2']);
    $this->assertMatchesRegularExpression('/^[0-9a-f]{12}$/', $after['b-1']);
  }

  /**
   * An image with no media reference carries its id as a trailing `{#id}`.
   *
   * It is the one block with two markdown forms, and only the fence form has
   * a prop list to hang an id on — so the plain form's trailing shorthand is
   * what keeps such a body publishable.
   */
  public function testPlainImagesAreIdentifiedBlocks(): void {
    $body = <<<'MD'
    ![A caption](https://example.com/a.png) {#b-img}

    ![Inline SVG](data:image/svg+xml;base64,PHN2Zy8+) {#b-svg}

    ::image{media="11111111-1111-1111-1111-111111111111" #b-media}
    ::
    MD;

    $this->assertSame(['b-img', 'b-svg', 'b-media'], array_keys($this->blocks->segment($body)));
    $this->assertSame('', $this->blocks->unaddressed($body));
  }

  /**
   * A blank line inside a code fence does not end the block.
   */
  public function testCodeFenceSurvivesBlankLines(): void {
    $body = "```php\n\$a = 1;\n\n\$b = 2;\n```\n\nAfter. {#b-after}";

    $this->assertSame(['b-after'], array_keys($this->blocks->segment($body)));
  }

  /**
   * The title heading is neither a block nor an unaddressed remainder.
   *
   * It is the title field's spelling in markdown; the frontend splits it off
   * before the document reaches an editor, so an id on it settles nothing and
   * its absence holds nothing back.
   */
  public function testTitleHeadingIsNeitherBlockNorRemainder(): void {
    foreach (["# Data model {#b-3a1c}", '# Data model'] as $heading) {
      $body = "$heading\n\nFirst paragraph. {#b-one}\n";
      $this->assertSame(['b-one'], array_keys($this->blocks->segment($body)));
      $this->assertSame('', $this->blocks->unaddressed($body));
    }

    // Only the first line. A heading further down is content like any other.
    $body = "# Data model\n\nFirst. {#b-one}\n\n# Later heading";
    $this->assertSame('# Later heading', $this->blocks->unaddressed($body));
  }

  /**
   * Changed blocks are the ones whose bytes moved, plus the ones that are new.
   */
  public function testChangedNamesMovedAndNewBlocks(): void {
    $old = "One. {#b-one}\n\nTwo. {#b-two}";
    $new = "One. {#b-one}\n\nTwo, expanded. {#b-two}\n\nThree. {#b-three}";

    $this->assertSame(['b-two', 'b-three'], $this->blocks->changed($new, $old));
  }

  /**
   * A shrunk block is a change like any other.
   */
  public function testShrunkBlockIsChanged(): void {
    $this->assertSame(['b-one'], $this->blocks->changed('A. {#b-one}', 'A much longer one. {#b-one}'));
  }

  /**
   * A block that kept its bytes and changed its place is changed (ADR 0017).
   *
   * Reordering says something different on the page, so it owes a review like
   * any other edit — and the bytes alone cannot see it.
   */
  public function testMovedBlockIsChanged(): void {
    $old = "One. {#b-one}\n\nTwo. {#b-two}\n\nThree. {#b-three}";
    $new = "Two. {#b-two}\n\nThree. {#b-three}\n\nOne. {#b-one}";

    $this->assertSame(['b-one'], $this->blocks->changed($new, $old));
  }

  /**
   * Inserting a block does not move the blocks under it.
   *
   * Every block below an insertion sits at a new index, and reading the index
   * would re-open the whole page for review on one new paragraph. What
   * counts is the order the blocks keep among themselves.
   */
  public function testAnInsertLeavesTheBlocksBelowItInPlace(): void {
    $old = "One. {#b-one}\n\nTwo. {#b-two}";
    $new = "Nought. {#b-nought}\n\nOne. {#b-one}\n\nTwo. {#b-two}";

    $this->assertSame(['b-nought'], $this->blocks->changed($new, $old));
  }

  /**
   * A removal is named by nothing else — the block is gone from the diff.
   */
  public function testRemovedNamesTheBlocksTheBodyDropped(): void {
    $old = "One. {#b-one}\n\nTwo. {#b-two}";

    $this->assertSame(['b-two'], $this->blocks->removed('One. {#b-one}', $old));
    $this->assertSame([], $this->blocks->removed($old, $old));
    $this->assertSame([], $this->blocks->changed('One. {#b-one}', $old));
  }

  /**
   * A removed block's entry is marked, so a reviewer knows what it stands for.
   */
  public function testMarkDeletedFlagsTheEntry(): void {
    $this->assertSame(
      ['contributors' => [], 'deleted' => TRUE],
      $this->blocks->markDeleted(['contributors' => []]),
    );
  }

  /**
   * The gate asks every review item alike, block or not (ADR 0017).
   */
  public function testBlockersNameEveryPendingItem(): void {
    $blockers = $this->blocks->blockers([
      'b-one' => ['pending:peer' => ['by' => [3], 'ok' => []]],
      'b-gone' => ['deleted' => TRUE, 'pending:peer' => ['by' => [3], 'ok' => []]],
      PageBlocks::FIELD_TITLE => ['pending:peer' => ['by' => [3], 'ok' => []]],
      'b-settled' => ['review:peer' => ['uid' => 7]],
    ], [PageBlocks::STEP_PEER]);

    $this->assertSame(
      ['b-gone', 'b-one', PageBlocks::FIELD_TITLE],
      array_keys($blockers),
    );
  }

  /**
   * A field entry signs off through the rules a block does — one set of them.
   */
  public function testFieldEntryFollowsTheFourEyesRule(): void {
    $title = $this->blocks->stamp([], 3, NULL, 'fago', 1000);

    $this->assertFalse($this->blocks->mayApprove($title, PageBlocks::STEP_PEER, 3));
    $this->assertTrue($this->blocks->mayApprove($title, PageBlocks::STEP_PEER, 7));

    $settled = $this->blocks->approve($title, PageBlocks::STEP_PEER, 7, 'ada', 1000, 5);
    $this->assertFalse($this->blocks->isPending($settled, PageBlocks::STEP_PEER));
  }

  /**
   * A write flags the peer step, and the agent step only for an agent.
   */
  public function testStampFlagsThePeerStepForEveryWriter(): void {
    $human = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $this->assertTrue($this->blocks->isPending($human, PageBlocks::STEP_PEER));
    $this->assertFalse($this->blocks->isPending($human, PageBlocks::STEP_AGENT));

    $agent = $this->blocks->stamp([], 3, 'Claude', 'fago', 1000);
    $this->assertTrue($this->blocks->isPending($agent, PageBlocks::STEP_AGENT));
  }

  /**
   * A session checkpoint credits every peer it names, and opens their episode.
   *
   * What a collaborative checkpoint can honestly say, and does: this block
   * changed, and here is who wrote it. Both the membership and the flag land in
   * the one write, so there is no moment where the block is flagged and its
   * episode names nobody — the moment its own author could sign it off. The
   * statement is membership only (ADR 0002): the contribution carries no
   * per-block character count.
   */
  public function testSessionWriteCreditsThePeersItNames(): void {
    $block = $this->blocks->stampSession([], [
      $this->w(3, NULL, 'fago'),
      $this->w(7, NULL, 'ada'),
    ], 1000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_AGENT));
    $this->assertSame([3, 7], array_column($block['contributors'], 'uid'));
    $this->assertSame([3, 7], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));
  }

  /**
   * A session write naming an agent raises the agent step (ADR 0002/0003).
   *
   * Agents are session peers now, entering the block's writer set with their
   * `via` label, and a member carrying one is what requires the agent step —
   * the requirement travels in the set, not on the checkpoint's credential.
   */
  public function testSessionWriteWithAnAgentRaisesTheAgentStep(): void {
    $block = $this->blocks->stampSession([], [
      $this->w(3, NULL, 'fago'),
      $this->w(3, 'Claude', 'fago'),
    ], 1000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_AGENT));
    // The account and the same account via the agent are separate members.
    $this->assertSame(
      [[3, NULL], [3, 'Claude']],
      array_map(static fn (array $c): array => [(int) $c['uid'], $c['via'] ?? NULL], $block['contributors']),
    );
  }

  /**
   * A human-only rework leaves a standing agent step in place.
   *
   * The set is monotone: once an agent wrote a block, a later human-only window
   * touches only the peer step, so the agent step it raised still stands —
   * agent involvement survives the human's rework (ADR 0002).
   */
  public function testAgentStepSurvivesHumanRework(): void {
    $block = $this->blocks->stampSession([], [$this->w(3, 'Claude', 'fago')], 1000);
    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_AGENT));

    $block = $this->blocks->stampSession($block, [$this->w(7, NULL, 'ada')], 2000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_AGENT), 'The agent step still stands.');
    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
  }

  /**
   * An admin may sign off their own change, and one naming nobody (ADR 0002).
   *
   * The four-eyes exception: the review is still recorded, never skipped, but a
   * writer who is an admin is not held out of it.
   */
  public function testAdminMaySelfApprove(): void {
    $sole = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $this->assertFalse($this->blocks->mayApprove($sole, PageBlocks::STEP_PEER, 3), 'A non-admin author may not.');
    $this->assertTrue($this->blocks->mayApprove($sole, PageBlocks::STEP_PEER, 3, TRUE), 'An admin author may.');

    $unaccounted = $this->blocks->stampSession([], [], 1000);
    $this->assertFalse($this->blocks->mayApprove($unaccounted, PageBlocks::STEP_PEER, 3), 'Nobody may, without admin.');
    $this->assertTrue($this->blocks->mayApprove($unaccounted, PageBlocks::STEP_PEER, 3, TRUE), 'An admin may clear an empty set.');
  }

  /**
   * An identified edit heals a block nobody could be named for.
   *
   * The empty baseline is the stamp text this server could not account for
   * gets, and it holds up the block until somebody edits it under a credential
   * — at which point the episode names a real writer and a second pair of eyes
   * can clear it. That recovery is what makes refusing everybody an acceptable
   * answer rather than a dead end.
   */
  public function testAnIdentifiedEditHealsAnEmptyBaseline(): void {
    $block = $this->blocks->stampSession([], [], 1000);
    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 3));

    $block = $this->blocks->stampSession($block, [$this->w(3, NULL, 'fago')], 2000);

    $this->assertSame([3], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));
    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 3), 'Still not its own author.');
    $this->assertTrue($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 7));
  }

  /**
   * It drops outdated approvals exactly as a credited write does.
   *
   * An approval given to text that has since moved is the endorsement nobody
   * made, and that is true whoever the writer turns out to be.
   */
  public function testSessionWriteUndoesTheApprovalsItOutdates(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 2000, 21);
    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));

    $block = $this->blocks->stampSession($block, [$this->w(3, NULL, 'fago')], 3000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
  }

  /**
   * An episode naming nobody is approvable by nobody.
   *
   * "Whoever wrote this may not sign it off" cannot be applied against a
   * baseline that does not say who wrote it, and answering yes there hands the
   * sole author the approval the rule exists to withhold. It is how a block
   * changed by writing no server could attribute is marked, so it is a state
   * every session can produce.
   */
  public function testEmptyBaselineIsApprovableByNobody(): void {
    $block = $this->blocks->stampSession([], [], 1000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 3));
    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 7));
  }

  /**
   * Unaccounted writing poisons an episode that already names an author.
   *
   * The reverse of the healing case, and the one that decides whether the
   * empty baseline is worth anything: a block open under an earlier author,
   * changed again by writing no server witnessed. Merging would leave that
   * author's name on it — non-empty, so the rule reads it as an ordinary
   * episode and lets them sign off text they never wrote, which is the state
   * naming nobody exists to prevent. So the names go, and so do the approvals
   * collected against what the block held before.
   */
  public function testUnaccountedWritingPoisonsTheOpenEpisode(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $this->assertSame([3], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));
    $this->assertTrue($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 7));

    $block = $this->blocks->stampSession($block, [], 2000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    $this->assertSame([], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));
    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 3), 'Not the earlier author.');
    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 7), 'Not anybody else.');
    $this->assertSame([3], array_column($block['contributors'], 'uid'), 'The byline it earned stands.');
  }

  /**
   * Unaccounted writing drops the approvals a settled step collected.
   *
   * A sign-off covers the text it was given to. Writing this server cannot
   * account for moved that text, so the step reopens — naming nobody, since
   * nothing here can say who moved it.
   */
  public function testUnaccountedWritingReopensTheSettledStep(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 2000, 21);
    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));

    $block = $this->blocks->stampSession($block, [], 3000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 7));
  }

  /**
   * A carried window widens an open episode without dropping its approvals.
   *
   * The window arrived on bytes this write did not move, so anything already
   * recorded against them still covers them — and the peers it names have to be
   * in the baseline all the same, or they are outsiders to their own writing.
   */
  public function testCarriedWindowWidensWithoutOutdatingAnything(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 3, 'fago', 1500, 20);
    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER), 'Its own author does not satisfy it.');

    $block = $this->blocks->carrySession($block, [$this->w(7, NULL, 'ada')], 2000);

    $this->assertSame([3, 7], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));
    $this->assertSame([3, 7], array_column($block['contributors'], 'uid'));
    $this->assertSame([3], array_column($block['pending:peer']['ok'], 'uid'), 'The approval on record stands.');
  }

  /**
   * A carried window reopens a step its own writer signed off.
   *
   * The bypass the carry path must not preserve: an agent's commit stored the
   * peer's text under its own credential, so the block's episode named the
   * agent's principal and the peer cleared it as an outsider. The window then
   * lands and says the peer wrote it — which makes that sign-off one the
   * four-eyes rule would never have accepted.
   */
  public function testCarriedWindowReopensTheStepItsOwnWriterCleared(): void {
    $block = $this->blocks->stamp([], 9, 'Claude', 'agent-owner', 1000);
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 1500, 20);
    $block = $this->blocks->approve($block, PageBlocks::STEP_AGENT, 7, 'ada', 1500, 20);
    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));

    $block = $this->blocks->carrySession($block, [$this->w(7, NULL, 'ada')], 2000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    // The re-opened episode names both writers, so 7 is on the mutual path
    // rather than the outsider one: their approval joins it and does not clear
    // it. What the reopen withdrew is the free pass, not their voice.
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 2500, 21);
    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    // A third account was never a writer of it, and clears it as one pair of
    // eyes that did not.
    $this->assertTrue($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 3));
  }

  /**
   * Re-opening a settled step keeps everyone it was already waiting on.
   *
   * The bypass a reopen seeded from the window alone would open: the account
   * that wrote the block's bulk is dropped from the baseline, so the step it is
   * left with names only the peer — and the dropped writer can then clear their
   * own text with a single approval, because a baseline of one name is
   * satisfied by anybody outside it.
   */
  public function testReopeningSettledStepKeepsTheWritersItAlreadyNamed(): void {
    $block = $this->blocks->stamp([], 9, 'Claude', 'agent-owner', 1000);
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 1500, 20);
    $block = $this->blocks->carrySession($block, [$this->w(7, NULL, 'ada')], 2000);

    $this->assertSame([9, 7], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));

    // 9 wrote the block. Their approval joins the episode; it does not close
    // it.
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 9, 'agent-owner', 2500, 21);
    $this->assertTrue(
      $this->blocks->isPending($block, PageBlocks::STEP_PEER),
      'A writer of the block may not settle it alone.',
    );

    // Both writers vouching for each other does — the mutual path, unchanged.
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 2600, 21);
    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));
  }

  /**
   * A sign-off that cannot say what it settled reopens on every writer.
   *
   * The bypass a record with no baseline of its own would open: Ada writes the
   * block, Bob clears it as an outsider, and a later window that moves no bytes
   * names only Bob. Re-opening on that window alone leaves a step naming one
   * account — and a baseline of one name is satisfied by anybody outside it, so
   * Ada signs off writing Ada did. The block's own contributors are the answer
   * instead, and they always hold its author.
   */
  public function testSignOffWithNoBaselineReopensOnEveryWriterOfTheBlock(): void {
    $block = $this->blocks->stamp([], 7, NULL, 'ada', 1000);
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 8, 'bob', 1500, 20);
    // A sign-off recorded without one, which is every sign-off given before the
    // record carried a baseline at all.
    unset($block['review:peer']['by']);

    $block = $this->blocks->carrySession($block, [$this->w(8, NULL, 'bob')], 2000);

    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    $this->assertSame([7, 8], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));
    // Ada wrote it, so that approval joins the episode and does not close it.
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 2500, 21);
    $this->assertTrue(
      $this->blocks->isPending($block, PageBlocks::STEP_PEER),
      'The account that wrote the block may not settle it alone.',
    );
    // Two writers vouching for each other settles it, as anywhere else.
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 8, 'bob', 2600, 21);
    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));
  }

  /**
   * A block that was never under review opens its first episode on the window.
   *
   * There is no sign-off here to be conservative about: nothing has ever been
   * cleared against this block, so the write that names writers for it is the
   * whole of what the episode knows.
   */
  public function testBlockWithNoSignOffOpensItsFirstEpisodeOnTheWindow(): void {
    $block = $this->blocks->carrySession([], [$this->w(7, NULL, 'ada')], 2000);

    $this->assertSame([7], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));
    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 7));
    $this->assertTrue($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 8));
  }

  /**
   * A carried window leaves somebody else's sign-off alone.
   */
  public function testCarriedWindowKeepsAnotherAccountsSignOff(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 9, 'reviewer', 1500, 20);
    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));

    $block = $this->blocks->carrySession($block, [$this->w(7, NULL, 'ada')], 2000);

    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    $this->assertSame(9, (int) $block['review:peer']['uid']);
  }

  /**
   * An account and the same account via an agent are separate contributors.
   */
  public function testAgentContributionIsItsOwnIdentity(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $block = $this->blocks->stamp($block, 3, 'Claude', 'fago', 2000);

    $this->assertSame(
      [[3, NULL], [3, 'Claude']],
      array_map(
        static fn (array $c): array => [(int) $c['uid'], $c['via'] ?? NULL],
        $block['contributors'],
      ),
    );
  }

  /**
   * A sole author cannot approve their own change; an outsider clears it.
   */
  public function testFourEyesNeedsSomebodyElse(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);

    $this->assertFalse($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 3));
    $this->assertTrue($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 7));

    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 3000, 21);

    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));
    $this->assertSame(21, $block['review:peer']['vid']);
  }

  /**
   * Two authors satisfy the step by approving each other, and only both do.
   */
  public function testMutualApprovalSatisfiesThePeerStep(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $block = $this->blocks->stamp($block, 7, NULL, 'ada', 2000);

    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 3, 'fago', 3000, 21);
    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER), 'One of two co-authors is not four eyes.');

    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 4000, 21);
    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_PEER));
  }

  /**
   * A change landing after an approval drops it — the step is pending again.
   */
  public function testAnEditUndoesTheApprovalsItOutdates(): void {
    $block = $this->blocks->stamp([], 3, NULL, 'fago', 1000);
    $block = $this->blocks->stamp($block, 7, NULL, 'ada', 2000);
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 3, 'fago', 3000, 21);

    $block = $this->blocks->stamp($block, 3, NULL, 'fago', 4000);

    $this->assertSame([3, 7], $this->blocks->contributorsSince($block, PageBlocks::STEP_PEER));
    $block = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'ada', 5000, 22);
    $this->assertTrue(
      $this->blocks->isPending($block, PageBlocks::STEP_PEER),
      "fago's approval was given to text that has moved since.",
    );
  }

  /**
   * The agent step asks for a human, not for a second pair of eyes.
   */
  public function testAgentStepIsClearedByItsOwnAuthor(): void {
    $block = $this->blocks->stamp([], 3, 'Claude', 'fago', 1000);

    $this->assertTrue($this->blocks->mayApprove($block, PageBlocks::STEP_AGENT, 3));

    $block = $this->blocks->approve($block, PageBlocks::STEP_AGENT, 3, 'fago', 3000, 21);

    $this->assertFalse($this->blocks->isPending($block, PageBlocks::STEP_AGENT));
    $this->assertTrue($this->blocks->isPending($block, PageBlocks::STEP_PEER), 'The peer step stands on its own.');
  }

  /**
   * Only the enforced steps hold a publication up.
   */
  public function testBlockersNameTheEnforcedStepsOnly(): void {
    $blocks = [
      'b-one' => $this->blocks->stamp([], 3, 'Claude', 'fago', 1000),
      'b-two' => [],
    ];

    $this->assertSame(
      ['b-one' => [PageBlocks::STEP_PEER, PageBlocks::STEP_AGENT]],
      $this->blocks->blockers($blocks, PageBlocks::STEPS),
    );
    $this->assertSame(
      ['b-one' => [PageBlocks::STEP_AGENT]],
      $this->blocks->blockers($blocks, [PageBlocks::STEP_AGENT]),
    );
  }

  /**
   * An unreadable sidecar decodes to nothing rather than wedging every write.
   */
  public function testUnreadableSidecarDecodesEmpty(): void {
    $this->assertSame([], $this->blocks->decode('not json'));
    $this->assertSame([], $this->blocks->decode(NULL));
    $this->assertSame('', $this->blocks->encode([]));
  }

  /**
   * An admin's approval settles the step, sole author or not (ADR 0002).
   *
   * MayApprove() admits them; approve() must not leave the step pending
   * behind a 200 — the two halves answer as one.
   */
  public function testAdminApprovalSettlesTheSoleAuthorStep(): void {
    $block = ['pending:peer' => ['by' => [7], 'ok' => []]];
    $this->assertTrue($this->blocks->mayApprove($block, PageBlocks::STEP_PEER, 7, TRUE));

    $settled = $this->blocks->approve($block, PageBlocks::STEP_PEER, 7, 'admin', 1000, 5, TRUE);
    $this->assertFalse($this->blocks->isPending($settled, PageBlocks::STEP_PEER));
  }

}
