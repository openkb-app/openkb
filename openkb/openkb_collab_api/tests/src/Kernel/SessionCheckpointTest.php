<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_collab_api\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Tests\openkb_agent\Traits\CollabClientTrait;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\openkb_workflow\PageBlocks;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_space_access\SpaceAccessPolicy;
use Symfony\Component\HttpFoundation\Response;

/**
 * What a collaborative checkpoint is, as the commit route sees one.
 *
 * A session checkpoint carries several peers' keystrokes, so — on the
 * collaboration client's own connection only — block credit comes from the
 * checkpoint rather than from whoever carried it, and the revision is filed
 * under the human the session names. A client may claim neither, and the last
 * two cases pin that: the same payload arriving on a session buys nothing,
 * however much the account behind it holds.
 *
 * The carriers are the real ones — a `client_credentials` token issued at
 * `/oauth/token`, and a session cookie with its CSRF token — so the commit
 * route answers through the http_kernel and this is a kernel test; presave
 * itself is covered in
 * \Drupal\Tests\openkb_workflow\Kernel\PresaveAttributionTest.
 *
 * @group openkb_collab_api
 */
final class SessionCheckpointTest extends OpenkbRequestKernelTestBase {

  use CollabClientTrait;

  /**
   * The body a page is seeded with — two addressable blocks.
   */
  private const SEED = "One. {#b-one}\n\nTwo. {#b-two}";

  /**
   * The body every case writes — block `b-two` moved, `b-one` untouched.
   */
  private const REWRITTEN = "One. {#b-one}\n\nTwo, rewritten. {#b-two}";

  /**
   * The other way round — block `b-one` moved, `b-two` untouched.
   */
  private const FIRST_REWRITTEN = "One, rewritten. {#b-one}\n\nTwo. {#b-two}";

  /**
   * The state only somebody holding its transition may name.
   */
  private const PUBLISHED = 'published';

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'custom_elements',
    'openkb_schema',
    'openkb_collab_api',
  ];

  /**
   * The suite's default space, created on first use. See ::space().
   */
  private ?SpaceInterface $space = NULL;

  /**
   * The suite's wiki space, created on first use. See ::wikiSpace().
   */
  private ?SpaceInterface $wikiSpace = NULL;

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
    $this->importRecipeConfig($this->collabClientConfigNames());
    $this->installConfig(['simple_oauth']);
    $this->installOauthKeys();
    $this->container->get('router.builder')->rebuild();
  }

  /**
   * An owed window is booked onto the revision it describes, not beside it.
   *
   * A statement is read on the collaboration client's connection and nowhere
   * else (ADR 0001), so a write that arrived on any other one — an agent's
   * token, an editor's cookie — leaves its window owed, and the next
   * checkpoint this server carries states it. That write re-sends text Drupal
   * already holds: it is bookkeeping about the revision it follows, and an
   * editor's history lane is for edits. So it leaves no entry, no relabelled
   * one, and no movement in `changed` — the token an open session reads to tell
   * somebody else's edit from its own.
   *
   * What it does leave is the credit, which is the whole reason it is sent.
   * The peer here typed the one block the earlier write left alone, so without
   * it their paragraph reaches Drupal with no episode on it at all — nothing to
   * review, and its writer free to sign it off. Stated, the block waits on a
   * second pair of eyes that are not theirs.
   */
  public function testOwedWindowIsBookedOntoTheRevisionItDescribes(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $peer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    // The write that could not state: the writer's own credential, their own
    // block, and no word about the peer typing beside them (ADR 0001).
    $carried = $this->postCommit($page, $writer, [
      'attributes' => [
        'field_kb_body' => ['value' => self::FIRST_REWRITTEN, 'format' => 'comark'],
        'revision_log' => 'OpenKB commit (save) — ' . $writer->getAccountName(),
      ],
    ]);
    $this->assertSame(200, $carried->getStatusCode(), (string) $carried->getContent());
    $this->assertArrayNotHasKey(
      'b-two',
      $this->sidecar($page),
      'The block the peer typed arrives unaccounted for.',
    );

    $revisions = $this->revisionIds($page);
    $stored = $this->workingCopy($page);

    $stated = $this->postCheckpoint($page, $server, [
      'attributes' => [
        'field_kb_body' => ['value' => self::FIRST_REWRITTEN, 'format' => 'comark'],
        // The label a carrier with no identity of its own builds: nothing.
        'revision_log' => 'OpenKB commit (save)',
      ],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $peer->id(), 'via' => NULL]]],
      ],
    ]);
    $this->assertSame(200, $stated->getStatusCode(), (string) $stated->getContent());

    $after = $this->workingCopy($page);
    $this->assertSame($revisions, $this->revisionIds($page), 'It leaves no entry in the history lane.');
    $this->assertSame(
      $stored->getRevisionLogMessage(),
      $after->getRevisionLogMessage(),
      'And does not take the label its writer earned.',
    );
    $this->assertSame(
      $stored->getChangedTime(),
      $after->getChangedTime(),
      'And moves no token an open session would read as an external edit.',
    );

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame(
      [(int) $peer->id()],
      $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER),
      'The window landed: the peer is on the block they typed.',
    );
    $this->assertFalse(
      $this->pageBlocks()->mayApprove($block, PageBlocks::STEP_PEER, (int) $peer->id()),
      'So the four-eyes step is not theirs to clear.',
    );
    $this->assertTrue(
      $this->pageBlocks()->mayApprove($block, PageBlocks::STEP_PEER, (int) $writer->id()),
      'It is somebody else\'s.',
    );
  }

  /**
   * A checkpoint that moves text is a revision, as every content write is.
   *
   * The other half of the rule above: it is what a write moved that decides,
   * not that it carried a statement.
   */
  public function testContentCheckpointStillWritesItsOwnRevision(): void {
    $carrier = $this->createCollabServer();
    $page = $this->createPage($carrier->id(), self::SEED);
    $before = $this->revisionIds($page);

    $response = $this->postCheckpoint($page, $carrier, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $carrier->id(),
        'blocks' => ['b-two' => [['uid' => (int) $carrier->id(), 'via' => NULL]]],
      ],
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $this->assertCount(count($before) + 1, $this->revisionIds($page));
  }

  /**
   * Both peers are credited, and both open the episode, in one write.
   *
   * The atomicity is the property: the text, the credits and the four-eyes
   * baseline are one save. There is no moment where Drupal holds the paragraph
   * and not the fact of who wrote it — which is the moment its author could
   * have signed it off.
   */
  public function testCheckpointRecordsTheWindowItCarries(): void {
    $carrier = $this->createCollabServer();
    $other = $this->createEditor();
    $page = $this->createPage($carrier->id(), self::SEED);

    $response = $this->postCheckpoint(
      $page,
      $carrier,
      [
        'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
        'session' => [
          'acting_uid' => (int) $other->id(),
          'blocks' => [
            'b-two' => [
            ['uid' => (int) $carrier->id(), 'via' => NULL],
            ['uid' => (int) $other->id(), 'via' => NULL],
            ],
          ],
        ],
      ],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $this->assertSame(
      (int) $other->id(),
      (int) $this->workingCopy($page)->getRevisionUser()->id(),
      'The revision is filed under the human the session measured, not the peer whose cookie carried it.',
    );

    $block = $this->sidecar($page)['b-two'];
    $this->assertTrue($this->pageBlocks()->isPending($block, PageBlocks::STEP_PEER));
    $this->assertSame(
      [(int) $carrier->id(), (int) $other->id()],
      array_column($block['contributors'], 'uid'),
      'Both peers are named — membership, not volume.',
    );
    $this->assertSame(
      [(int) $carrier->id(), (int) $other->id()],
      $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER),
      'And both are in the four-eyes baseline the same save opened.',
    );
  }

  /**
   * A changed block the window names nobody on is stamped for NOBODY.
   *
   * The map is exhaustive — the collaboration server books every block whose
   * content moves, so what it does not name is not this session's writing at
   * all, but text left behind by a window whose accounting never reached a
   * write. Naming the peers who are in the room now would hand the four-eyes
   * baseline to bystanders and leave the writing's real author an outsider,
   * free to sign it off. An episode naming nobody is refused for everybody,
   * and one identified edit is all it takes to heal.
   */
  public function testUnaccountedChangeIsApprovableByNobody(): void {
    $carrier = $this->createCollabServer();
    $other = $this->createEditor();
    $page = $this->createPage($carrier->id(), self::SEED);

    $response = $this->postCheckpoint(
      $page,
      $carrier,
      [
        'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
        'session' => [
          'acting_uid' => NULL,
          'blocks' => [],
        ],
      ],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame([], $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER));
    $this->assertSame([], $block['contributors'] ?? [], 'Nobody is credited a character for it.');
    foreach ([$carrier, $other] as $account) {
      $this->assertFalse(
        $this->pageBlocks()->mayApprove($block, PageBlocks::STEP_PEER, (int) $account->id()),
      );
    }
  }

  /**
   * A checkpoint carrying no accounting at all says nothing about anybody.
   *
   * The statement is made and states no window — the shape a checkpoint takes
   * when its ledger was lost. It is the same answer as any unaccounted block:
   * the carrier is not written into the baseline for writing nobody witnessed
   * them do, and nobody may sign it off until an identified edit re-stamps it.
   */
  public function testCheckpointThatNamesNobodyCreditsNobody(): void {
    $carrier = $this->createCollabServer();
    $reviewer = $this->createEditor();
    $page = $this->createPage($carrier->id(), self::SEED);

    $response = $this->postCheckpoint(
      $page,
      $carrier,
      [
        'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
        'session' => ['blocks' => []],
      ],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame([], $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER));
    $this->assertSame([], $block['contributors'] ?? [], 'And nobody is credited for it.');
    $this->assertFalse($this->pageBlocks()->mayApprove($block, PageBlocks::STEP_PEER, (int) $carrier->id()));
    $this->assertFalse($this->pageBlocks()->mayApprove($block, PageBlocks::STEP_PEER, (int) $reviewer->id()));
  }

  /**
   * An id that names no account is not credited, and does not stand in the way.
   *
   * Membership is the witnessed fact and survives whatever became of the
   * account — dropping it would replace a named episode with an unaccounted
   * one and lose an agent's via. Only the display name is absent for an
   * account that no longer resolves.
   */
  public function testContributorThatIsNoAccountKeepsMembership(): void {
    $carrier = $this->createCollabServer();
    $page = $this->createPage($carrier->id(), self::SEED);

    $response = $this->postCheckpoint(
      $page,
      $carrier,
      [
        'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
        'session' => [
          'acting_uid' => NULL,
          'blocks' => [
            'b-two' => [
            ['uid' => (int) $carrier->id(), 'via' => NULL],
            ['uid' => 987654, 'via' => NULL],
            ],
          ],
        ],
      ],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $block = $this->sidecar($page)['b-two'];
    $this->assertSame(
      [(int) $carrier->id(), 987654],
      array_column($block['contributors'], 'uid'),
    );
    // The unresolvable account carries no display name.
    foreach ($block['contributors'] as $contributor) {
      if ($contributor['uid'] === 987654) {
        $this->assertNull($contributor['name'] ?? NULL);
      }
    }
    $this->assertSame(
      [(int) $carrier->id(), 987654],
      $this->pageBlocks()->contributorsSince($block, PageBlocks::STEP_PEER),
    );
  }

  /**
   * A stated user who may not write the page writes nothing.
   *
   * The route's own access ran against the carrier, which holds
   * `use collaboration api` and reaches every space. Once the request is the
   * stated user, the page is asked again — and an outsider is refused there,
   * with nothing written. Otherwise the server's floor would be a way to write
   * into a space under the name of somebody who has no seat in it.
   */
  public function testStatedUserWithoutAccessIsRefused(): void {
    $carrier = $this->createCollabServer();
    $outsider = $this->createUser();
    $page = $this->createPage($carrier->id(), self::SEED);
    $before = $this->workingCopy($page)->get('field_kb_body')->value;

    $response = $this->postCheckpoint(
      $page,
      $carrier,
      [
        'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
        'session' => ['acting_uid' => (int) $outsider->id(), 'blocks' => []],
      ],
    );
    $this->assertSame(403, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame($before, $this->workingCopy($page)->get('field_kb_body')->value);
  }

  /**
   * The publish answers to the user who asked for it, not to the server.
   *
   * The whole point of becoming them: the collaboration server's own role holds
   * the draft transition and nothing else, and the account it acts as here
   * holds no publish transition either. content_moderation runs its check after
   * the switch, so the write is refused as that user — a person the editor UI
   * would have hidden the button from cannot reach past it either.
   */
  public function testStatedUserWithoutPublishRightsCannotPublish(): void {
    $carrier = $this->createCollabServer();
    $drafter = $this->createDrafter();
    $page = $this->createPage($drafter->id(), self::SEED, 'draft');

    $refused = $this->postCheckpoint($page, $carrier, [
      'attributes' => ['moderation_state' => self::PUBLISHED],
      'session' => ['acting_uid' => (int) $drafter->id(), 'blocks' => []],
    ]);
    $this->assertSame(422, $refused->getStatusCode(), (string) $refused->getContent());
    $this->assertStringContainsString('You do not have access to transition from Draft to Published', (string) $refused->getContent());
    $this->assertFalse($this->workingCopy($page)->isPublished(), 'And nothing went live.');

    // The same payload, stating somebody who does hold the transition.
    $publisher = $this->createEditor();
    $allowed = $this->postCheckpoint($page, $carrier, [
      'attributes' => ['moderation_state' => self::PUBLISHED],
      'session' => ['acting_uid' => (int) $publisher->id(), 'blocks' => []],
    ]);
    $this->assertSame(200, $allowed->getStatusCode(), (string) $allowed->getContent());
    $this->assertTrue($this->workingCopy($page)->isPublished());
    $this->assertSame(
      (int) $publisher->id(),
      (int) $this->workingCopy($page)->getRevisionUser()->id(),
      'And it is filed under them, because it is their write.',
    );
  }

  /**
   * Off the client's connection the same payload buys nothing at all.
   *
   * The case that makes the identity load-bearing rather than decorative. The
   * caller here is a site administrator — every permission there is,
   * `use collaboration api` included — sending the identical body and the
   * identical `session` block over a session cookie. It is credited for its
   * own writing, files the revision under itself, and cannot write anybody
   * else into the baseline. Were it otherwise, holding a permission would be
   * enough to write, keep yourself out of the record, and sign the result off
   * alone.
   */
  public function testOffTheConnectionTheWriteIsAnOrdinaryOne(): void {
    $admin = $this->createUser([], NULL, TRUE);
    $this->space()->get('managers')->appendItem(['target_id' => $admin->id()]);
    $this->space()->save();
    $other = $this->createEditor();
    $page = $this->createPage($admin->id(), self::SEED);

    $response = $this->postCommit($page, $admin, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $other->id(),
        'blocks' => ['b-two' => [['uid' => (int) $other->id(), 'via' => NULL]]],
      ],
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $this->assertSame(
      (int) $admin->id(),
      (int) $this->workingCopy($page)->getRevisionUser()->id(),
      'A revision author nobody vouched for is not taken.',
    );
    $this->assertSame(
      [(int) $admin->id()],
      $this->pageBlocks()->contributorsSince(
        $this->sidecar($page)['b-two'],
        PageBlocks::STEP_PEER,
      ),
      'And the writer is credited, so they cannot sign their own change off alone.',
    );
  }

  /**
   * A sign-off by the change's only contributor is refused, and says why.
   *
   * The sign-off rides the same statement as the writing it is about: the
   * credit and the flag are one save, and the sign-off is recorded in it. The
   * block stays pending, the reviewer gets Drupal's sentence back, and the
   * text the session carried is saved all the same.
   */
  public function testStatedSignOffIsRefusedToTheOnlyContributor(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $response = $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
        'actions' => [$this->signOff('b-two', $writer)],
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $review = $this->review($response);
    $this->assertSame([], $review['approved']);
    $this->assertSame(
      [
        [
          'item' => 'b-two',
          'step' => PageBlocks::STEP_PEER,
          'uid' => (int) $writer->id(),
          'reason' => 'Block b-two needs a second pair of eyes: its only contributor is the account approving it.',
        ],
      ],
      $review['refused'],
    );
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
    $this->assertStringContainsString('Two, rewritten.', (string) $this->workingCopy($page)->get('field_kb_body')->value);
  }

  /**
   * A block nobody is on record as writing asks for an edit, not for eyes.
   *
   * The two refusals ask for different things, and telling the reviewer of an
   * unaccounted block that they are its only contributor sends them looking
   * for a colleague when what it needs is an identified edit.
   */
  public function testStatedSignOffOnAnUnaccountedBlockAsksForAnEdit(): void {
    $server = $this->createCollabServer();
    $reviewer = $this->createEditor();
    $page = $this->createPage($server->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => ['acting_uid' => NULL, 'blocks' => []],
    ]);
    $response = $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $reviewer->id(),
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $reviewer)],
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame(
      'Block b-two needs an identified edit before anybody can sign it off: nothing on record says who wrote it.',
      $this->review($response)['refused'][0]['reason'],
    );
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * A peer who did not write it clears the step, on the revision they saw.
   */
  public function testStatedSignOffByPeerClearsTheStep(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $read = (int) $this->workingCopy($page)->getRevisionId();

    $response = $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $reviewer->id(),
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $reviewer)],
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame(
      [['item' => 'b-two', 'step' => PageBlocks::STEP_PEER, 'uid' => (int) $reviewer->id()]],
      $this->review($response)['approved'],
    );
    $block = $this->sidecar($page)['b-two'];
    $this->assertFalse($this->pageBlocks()->isPending($block, PageBlocks::STEP_PEER));
    $this->assertSame((int) $reviewer->id(), $block['review:peer']['uid']);
    $this->assertSame(
      $read,
      $block['review:peer']['vid'],
      'The sign-off names the revision the reviewer read, not the one it wrote.',
    );
  }

  /**
   * A removed block is signed off through its record, not by its own writer.
   *
   * The block is gone from the body, so its record is the only thing a
   * sign-off can name — and it answers to the same four-eyes rule as a block
   * the body still holds (ADR 0017).
   */
  public function testStatedSignOffOnRemovedBlockFollowsTheSameRule(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => 'One. {#b-one}', 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));

    $own = $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $writer)],
      ],
    ]);
    $this->assertSame(
      'Block b-two needs a second pair of eyes: its only contributor is the account approving it.',
      $this->review($own)['refused'][0]['reason'],
    );

    $response = $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $reviewer->id(),
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $reviewer)],
      ],
    ]);

    $this->assertSame(
      [['item' => 'b-two', 'step' => PageBlocks::STEP_PEER, 'uid' => (int) $reviewer->id()]],
      $this->review($response)['approved'],
    );
    $this->assertFalse($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * The title's entry is signed off like a block's, and named as the title.
   */
  public function testStatedSignOffOnTheTitleFollowsTheSameRule(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['title' => 'A different name for the same text'],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => [PageBlocks::FIELD_TITLE => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $this->assertTrue($this->pageBlocks()->isPending(
      $this->sidecar($page)[PageBlocks::FIELD_TITLE],
      PageBlocks::STEP_PEER,
    ));

    $own = $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => [],
        'actions' => [$this->signOff(PageBlocks::FIELD_TITLE, $writer)],
      ],
    ]);
    $this->assertSame(
      'The page title needs a second pair of eyes: its only contributor is the account approving it.',
      $this->review($own)['refused'][0]['reason'],
    );

    $response = $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $reviewer->id(),
        'blocks' => [],
        'actions' => [$this->signOff(PageBlocks::FIELD_TITLE, $reviewer)],
      ],
    ]);

    $this->assertSame(
      [
        [
          'item' => PageBlocks::FIELD_TITLE,
          'step' => PageBlocks::STEP_PEER,
          'uid' => (int) $reviewer->id(),
        ],
      ],
      $this->review($response)['approved'],
    );
    $this->assertFalse($this->pageBlocks()->isPending(
      $this->sidecar($page)[PageBlocks::FIELD_TITLE],
      PageBlocks::STEP_PEER,
    ));
  }

  /**
   * Two co-authors approving each other satisfy the step; one of them does not.
   */
  public function testMutualStatedSignOffsSatisfyTheStep(): void {
    $server = $this->createCollabServer();
    $first = $this->createEditor();
    $second = $this->createEditor();
    $page = $this->createPage($first->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $first->id(),
        'blocks' => [
          'b-two' => [
            ['uid' => (int) $first->id(), 'via' => NULL],
            ['uid' => (int) $second->id(), 'via' => NULL],
          ],
        ],
      ],
    ]);

    $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $first->id(),
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $first)],
      ],
    ]);
    $this->assertTrue(
      $this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER),
      'One of two co-authors is not four eyes yet.',
    );

    $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $second->id(),
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $second)],
      ],
    ]);
    $this->assertFalse($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * An admin signs off their own block; everybody else is held to the rule.
   */
  public function testAdminStatedSignOffSettlesTheirOwnBlock(): void {
    $server = $this->createCollabServer();
    $admin = $this->createEditorWith(['administer nodes']);
    $page = $this->createPage($admin->id(), self::SEED);

    $response = $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $admin->id(),
        'blocks' => ['b-two' => [['uid' => (int) $admin->id(), 'via' => NULL]]],
        'actions' => [$this->signOff('b-two', $admin)],
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame([], $this->review($response)['refused']);
    $block = $this->sidecar($page)['b-two'];
    $this->assertFalse($this->pageBlocks()->isPending($block, PageBlocks::STEP_PEER));
    $this->assertSame((int) $admin->id(), $block['review:peer']['uid'], 'The review is recorded, never skipped.');
  }

  /**
   * The admin exception reaches an item with no text of its own (ADR 0002).
   *
   * A removal and a rename are the two changes a reviewer cannot be walked to
   * in the document, so they are the two the exception is most likely to be
   * asked for.
   */
  public function testAdminStatedSignOffSettlesTheirOwnRemovalAndRename(): void {
    $server = $this->createCollabServer();
    $admin = $this->createEditorWith(['administer nodes']);
    $page = $this->createPage($admin->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => [
        'title' => 'A different name for the same text',
        'field_kb_body' => ['value' => 'One. {#b-one}', 'format' => 'comark'],
      ],
      'session' => [
        'acting_uid' => (int) $admin->id(),
        'blocks' => [
          'b-two' => [['uid' => (int) $admin->id(), 'via' => NULL]],
          PageBlocks::FIELD_TITLE => [['uid' => (int) $admin->id(), 'via' => NULL]],
        ],
      ],
    ]);

    $response = $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $admin->id(),
        'blocks' => [],
        'actions' => [
          $this->signOff('b-two', $admin),
          $this->signOff(PageBlocks::FIELD_TITLE, $admin),
        ],
      ],
    ]);

    $this->assertSame([], $this->review($response)['refused']);
    $sidecar = $this->sidecar($page);
    foreach (['b-two', PageBlocks::FIELD_TITLE] as $item) {
      $this->assertFalse($this->pageBlocks()->isPending($sidecar[$item], PageBlocks::STEP_PEER), $item);
      $this->assertSame(
        (int) $admin->id(),
        $sidecar[$item]['review:peer']['uid'],
        'The review is recorded, never skipped.',
      );
    }
  }

  /**
   * A sign-off by somebody who may not edit the page is refused.
   *
   * Update access is the editor roster inside a space, and the account here
   * holds everything the recipe grants and is on no roster. The statement
   * names it as the reviewer, which is exactly the claim Drupal does not take
   * on trust.
   */
  public function testStatedSignOffNeedsUpdateAccess(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $outsider = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $response = $this->postCheckpoint($page, $server, [
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $outsider)],
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame(
      sprintf('%s may not sign off on this page.', $outsider->getAccountName()),
      $this->review($response)['refused'][0]['reason'],
    );
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * A sign-off on a block somebody else already settled records nothing.
   *
   * Two reviewers signing off the same block is an ordinary race, not an error:
   * the second sign-off finds the step settled, and the reviewer has nothing to
   * be told.
   */
  public function testStatedSignOffOfSettledBlockRecordsNothing(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $first = $this->createEditor();
    $second = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $this->postCheckpoint($page, $server, [
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $first)]],
    ]);

    $response = $this->postCheckpoint($page, $server, [
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $second)]],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame(['approved' => [], 'refused' => []], $this->review($response));
    $this->assertSame(
      (int) $first->id(),
      $this->sidecar($page)['b-two']['review:peer']['uid'],
      'The sign-off already on record stands.',
    );
  }

  /**
   * A Publish over a block still owing review is refused, in every space.
   *
   * A wiki space enforces fewer review steps than a moderated one, not none:
   * the agent step is waited for in both. Nothing is written either way, so
   * the editor keeps the text the checkpoint carried.
   */
  public function testPublishOverPendingBlockIsRefusedInEverySpace(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();

    foreach ([$this->space(), $this->wikiSpace()] as $space) {
      $this->rosterOnto($space, $server, $writer);
      $page = $this->createPageIn($space, $writer->id(), self::SEED);

      // An agent's write, which owes the agent step wherever it lands.
      $this->postCheckpoint($page, $server, [
        'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
        'session' => [
          'acting_uid' => (int) $writer->id(),
          'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => 'claude']]],
        ],
      ]);
      $vid_before = (int) $this->workingCopy($page)->getRevisionId();

      $response = $this->postCheckpoint($page, $server, [
        'attributes' => ['moderation_state' => self::PUBLISHED],
        'session' => ['acting_uid' => (int) $writer->id(), 'blocks' => []],
      ]);

      $this->assertSame(422, $response->getStatusCode(), $space->label() . ': ' . $response->getContent());
      $this->assertStringContainsString('Block b-two is waiting for:', (string) $response->getContent());
      $this->assertSame($vid_before, (int) $this->workingCopy($page)->getRevisionId(), 'Nothing was written.');
      $this->assertFalse($this->workingCopy($page)->isPublished());
    }
  }

  /**
   * A sign-off in a draft of a live page is its own revision.
   *
   * A published page owes its review steps in the draft that edits it, so
   * the sign-off writes a revision of its own and says in words what it
   * recorded, and the published text readers get stays where it is.
   */
  public function testSignOffInThePublishedPagesDraftIsItsOwnRevision(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);
    $live = (int) $this->nodeStorage()->load($page->id())->getRevisionId();

    // The edit no reader sees yet: it lands as a draft, owing the peer step.
    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $this->assertSame('draft', (string) $this->workingCopy($page)->get('moderation_state')->value);
    $before = $this->revisionIds($page);

    $response = $this->postCheckpoint($page, $server, [
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $reviewer)]],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertCount(1, $this->review($response)['approved']);
    $this->assertCount(count($before) + 1, $this->revisionIds($page), 'The review is a version of its own.');
    $this->assertSame(
      sprintf('Signed off 1 change(s) (peer) by %s.', $reviewer->getDisplayName()),
      (string) $this->workingCopy($page)->getRevisionLogMessage(),
    );
    $this->assertSame(
      'draft',
      (string) $this->workingCopy($page)->get('moderation_state')->value,
      'The draft it was signed off in is still a draft.',
    );

    $default = $this->nodeStorage()->load($page->id());
    $this->assertTrue($default->isPublished());
    $this->assertSame($live, (int) $default->getRevisionId(), 'Readers are on the revision they were.');
    $this->assertSame(self::SEED, (string) $default->get('field_kb_body')->value);
    $this->assertTrue($this->moderationStatus($page)['hasUnpublishedChanges']);
  }

  /**
   * A sign-off on a draft leaves it a draft.
   */
  public function testSignOffOnDraftLeavesItDraft(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED, 'draft');

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);

    $response = $this->postCheckpoint($page, $server, [
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $reviewer)]],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertCount(1, $this->review($response)['approved']);
    $this->assertSame('draft', (string) $this->workingCopy($page)->get('moderation_state')->value);
    $this->assertFalse($this->nodeStorage()->load($page->id())->isPublished());
  }

  /**
   * One checkpoint may carry the last sign-off and the publish it clears.
   *
   * The sign-offs are recorded while Drupal computes the sidecar this save
   * writes, so the publish gate reads them. Two acts, one save.
   */
  public function testCheckpointCarryingTheLastSignOffPublishes(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED, 'draft');

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);

    $response = $this->postCheckpoint($page, $server, [
      'attributes' => ['moderation_state' => self::PUBLISHED],
      'session' => [
        'acting_uid' => (int) $reviewer->id(),
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $reviewer)],
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertCount(1, $this->review($response)['approved']);
    $this->assertTrue($this->nodeStorage()->load($page->id())->isPublished());
    $this->assertStringContainsString('Two, rewritten.', (string) $this->nodeStorage()->load($page->id())->get('field_kb_body')->value);
  }

  /**
   * A publish in the checkpoint after the sign-off goes through just as well.
   */
  public function testPublishFollowingTheSignOffGoesThrough(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED, 'draft');

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $this->postCheckpoint($page, $server, [
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $reviewer)]],
    ]);

    $response = $this->postCheckpoint($page, $server, [
      'attributes' => ['moderation_state' => self::PUBLISHED],
      'session' => ['acting_uid' => (int) $reviewer->id(), 'blocks' => []],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertTrue($this->nodeStorage()->load($page->id())->isPublished());
  }

  /**
   * A reviewer the same window names on the block cannot sign it off.
   *
   * Where four-eyes is kept: the sign-offs are applied after this save's own
   * writers are recorded, so a reviewer who typed in the block during this
   * checkpoint is in its writer set and the rule refuses them.
   */
  public function testSignOffByWriterOfTheSameWindowIsRefused(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED, 'draft');

    $response = $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
        'actions' => [$this->signOff('b-two', $writer)],
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame([], $this->review($response)['approved']);
    $this->assertSame(
      'Block b-two needs a second pair of eyes: its only contributor is the account approving it.',
      $this->review($response)['refused'][0]['reason'],
    );
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * Off the collaboration connection a stated sign-off buys nothing.
   *
   * The statement is believed on the `collab` scope alone (ADR 0001), so the
   * same body over a cookie session — from the very account that wrote the
   * block, holding everything the recipe grants — moves no review state. This
   * is the whole point of carrying the sign-off in the statement rather than in
   * a field or an endpoint a browser can reach.
   */
  public function testStatedSignOffOnlyRidesTheCollaborationConnection(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);

    $response = $this->postCommit($page, $reviewer, [
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $reviewer)]],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame(['approved' => [], 'refused' => []], $this->review($response), 'The statement bought nothing.');
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * An agent's seat may not sign off, whatever the statement says.
   *
   * The agent step asks for a human, so any human approver clears it — which
   * is exactly why the reviewer has to be one. Drupal refuses the sign-off
   * on its own side of the wire: the collaboration server turns an agent seat
   * away too, but the gate is Drupal's and fails closed without it (ADR 0004).
   */
  public function testStatedSignOffFromAnAgentSeatIsRefused(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $response = $this->postCheckpoint($page, $server, [
      'session' => [
        'blocks' => [],
        'actions' => [$this->signOff('b-two', $reviewer, 'agent-one')],
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame([], $this->review($response)['approved']);
    $this->assertSame(
      'An agent may not sign off a review step.',
      $this->review($response)['refused'][0]['reason'],
    );
    $this->assertTrue(
      $this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER),
      'And the block still owes what it owed.',
    );

    // The same sign-off off the agent's seat is the one the rule allows.
    $allowed = $this->postCheckpoint($page, $server, [
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $reviewer)]],
    ]);
    $this->assertSame([], $this->review($allowed)['refused']);
    $this->assertFalse($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * A sign-off by an account that is gone is refused, and says so.
   */
  public function testStatedSignOffByBlockedAccountIsRefused(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $reviewer->block();
    $reviewer->save();

    $response = $this->postCheckpoint($page, $server, [
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $reviewer)]],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame(
      'The account that signed off is blocked or gone.',
      $this->review($response)['refused'][0]['reason'],
    );
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * A checkpoint on a base the page moved past takes its sign-offs with it.
   *
   * The stale refusal is judged before anything is applied, so a statement
   * built against text somebody has since replaced writes neither the text nor
   * the sign-offs it carried.
   */
  public function testStatedSignOffOnStaleBaseIsRefusedWholly(): void {
    $server = $this->createCollabServer();
    $writer = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($writer->id(), self::SEED);

    $this->postCheckpoint($page, $server, [
      'attributes' => ['field_kb_body' => ['value' => self::REWRITTEN, 'format' => 'comark']],
      'session' => [
        'acting_uid' => (int) $writer->id(),
        'blocks' => ['b-two' => [['uid' => (int) $writer->id(), 'via' => NULL]]],
      ],
    ]);
    $sidecar_before = $this->sidecar($page);

    $response = $this->postCheckpoint($page, $server, [
      'based_on_changed' => (int) $this->workingCopy($page)->getChangedTime() - 60,
      'session' => ['blocks' => [], 'actions' => [$this->signOff('b-two', $reviewer)]],
    ]);

    $this->assertSame(409, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame($sidecar_before, $this->sidecar($page), 'The sidecar is untouched.');
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * One stated sign-off, as the collaboration server records it.
   *
   * @param string $item
   *   The review item signed off.
   * @param \Drupal\Core\Session\AccountInterface $account
   *   The account the connection belongs to.
   * @param string|null $via
   *   The agent whose seat the connection holds, or NULL for a person's own.
   *
   * @return array
   *   The action.
   */
  private function signOff(string $item, AccountInterface $account, ?string $via = NULL): array {
    return [
      'item' => $item,
      'step' => PageBlocks::STEP_PEER,
      'uid' => (int) $account->id(),
      'via' => $via,
    ];
  }

  /**
   * What the response says became of the sign-offs it carried.
   *
   * @param \Symfony\Component\HttpFoundation\Response $response
   *   The commit response.
   *
   * @return array{approved: array, refused: array}
   *   The `review` meta member.
   */
  private function review(Response $response): array {
    return Json::decode((string) $response->getContent())['meta']['review'];
  }

  /**
   * POSTs a checkpoint on the collaboration client's own connection.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param \Drupal\Core\Session\AccountInterface $server
   *   The service account the client acts as.
   * @param array $payload
   *   The commit payload.
   *
   * @return \Symfony\Component\HttpFoundation\Response
   *   The response.
   */
  private function postCheckpoint(NodeInterface $page, AccountInterface $server, array $payload): Response {
    return $this->request(
      '/openkb/node/' . $page->id() . '/commit',
      NULL,
      'POST',
      $payload,
      $this->collabBearer($server),
    );
  }

  /**
   * POSTs a commit payload as the given user, over their session and CSRF.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   * @param array $payload
   *   The commit payload.
   * @param array $headers
   *   Extra request headers, e.g. the collaboration server's credential.
   *
   * @return \Symfony\Component\HttpFoundation\Response
   *   The response.
   */
  private function postCommit(NodeInterface $page, AccountInterface $user, array $payload, array $headers = []): Response {
    return $this->request(
      '/openkb/node/' . $page->id() . '/commit',
      $user,
      'POST',
      $payload,
      // Generator and validator share the session_manager.metadata_bag
      // service in-process, so this token is the one the route accepts.
      $headers + ['X-CSRF-Token' => $this->container->get('csrf_token')->get('rest')],
    );
  }

  /**
   * The suite's default space — moderated, and every editor it made is in it.
   */
  private function space(): SpaceInterface {
    return $this->space ??= Space::create([
      'label' => 'Moderated space',
      'read_access' => 'all_users',
      'field_moderation' => 1,
      'managers' => [],
    ]);
  }

  /**
   * An account on the space roster that may draft but never publish.
   *
   * Everything `authenticated` grants except the publish transition — the
   * account the editor chrome hides the Publish button from.
   */
  private function createDrafter(): AccountInterface {
    $permissions = array_diff(
      $this->recipeGrantedPermissions('authenticated'),
      ['use editorial transition publish'],
    );
    $account = $this->createUser($permissions);
    $space = $this->space();
    $space->get('managers')->appendItem(['target_id' => $account->id()]);
    $space->save();
    return $account;
  }

  /**
   * The account the collaboration client acts as.
   *
   * An ordinary editor with one permission more — access, and nothing else.
   * What separates a checkpoint from a browser save is the connection it
   * arrives on, which {@see self::postCheckpoint()} makes (ADR 0001).
   */
  private function createCollabServer(): AccountInterface {
    return $this->createEditorWith([SpaceAccessPolicy::COLLABORATION]);
  }

  /**
   * An account holding what the recipe grants, on the default space's roster.
   */
  private function createEditor(): AccountInterface {
    return $this->createEditorWith([]);
  }

  /**
   * An account holding the recipe's grants plus whatever else it is given.
   *
   * @param string[] $extra
   *   Further permissions.
   *
   * @return \Drupal\Core\Session\AccountInterface
   *   The account, on the default space's roster.
   */
  private function createEditorWith(array $extra): AccountInterface {
    $permissions = $this->recipeGrantedPermissions('authenticated');
    $account = $this->createUser(array_unique([...$permissions, ...$extra]));
    $space = $this->space();
    $space->get('managers')->appendItem(['target_id' => $account->id()]);
    $space->save();
    return $account;
  }

  /**
   * A wiki space — no peer review, and the agent step its only enforced one.
   */
  private function wikiSpace(): SpaceInterface {
    return $this->wikiSpace ??= Space::create([
      'label' => 'Wiki space',
      'read_access' => 'all_users',
      'field_moderation' => 0,
      'managers' => [],
    ]);
  }

  /**
   * Puts accounts on a space's roster, which is where update access comes from.
   *
   * @param \Drupal\openkb_space\SpaceInterface $space
   *   The space.
   * @param \Drupal\Core\Session\AccountInterface ...$accounts
   *   The accounts to roster.
   */
  private function rosterOnto(SpaceInterface $space, AccountInterface ...$accounts): void {
    foreach ($accounts as $account) {
      $space->get('managers')->appendItem(['target_id' => $account->id()]);
    }
    $space->save();
  }

  /**
   * A published page with a settled review history, in the default space.
   *
   * Direct ->save() skips entity validation, so no transition permission is
   * needed to seed it; presave flags its blocks and the flags are then cleared,
   * so the page stands for content already through review.
   */
  private function createPage(string|int $uid, string $body, string $state = 'published'): NodeInterface {
    return $this->createPageIn($this->space(), $uid, $body, $state);
  }

  /**
   * The same, in the space it is given.
   */
  private function createPageIn(SpaceInterface $space, string|int $uid, string $body, string $state = 'published'): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Collab page',
      'uid' => $uid,
      'moderation_state' => $state,
      'field_space' => $space->id(),
      'field_kb_body' => ['value' => $body, 'format' => 'comark'],
    ]);
    $page->save();
    $page->set('field_block_meta', NULL);
    $page->setNewRevision(FALSE);
    $page->save();
    return $page;
  }

  /**
   * The moderation status document the editor chrome reads.
   */
  private function moderationStatus(NodeInterface $page): array {
    return $this->container->get('openkb_workflow.moderation_status')
      ->of($this->nodeStorage()->load($page->id()));
  }

  /**
   * The block model, as the site wires it.
   */
  private function pageBlocks(): PageBlocks {
    return $this->container->get('openkb_workflow.page_blocks');
  }

  /**
   * The node storage, with its static cache cleared.
   */
  private function nodeStorage(): NodeStorageInterface {
    /** @var \Drupal\node\NodeStorageInterface $storage */
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    return $storage;
  }

  /**
   * The page's latest revision, default or not — what the editor works on.
   */
  private function workingCopy(NodeInterface $page): NodeInterface {
    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    return $latest;
  }

  /**
   * Every revision the page has, oldest first.
   *
   * @return int[]
   *   The revision ids.
   */
  private function revisionIds(NodeInterface $page): array {
    $ids = $this->nodeStorage()->getQuery()
      ->allRevisions()
      ->accessCheck(FALSE)
      ->condition('nid', $page->id())
      ->execute();
    return array_map('intval', array_keys($ids));
  }

  /**
   * The stored review sidecar of the page's working copy.
   *
   * @return array<string, array>
   *   Block id => the block's sidecar entry.
   */
  private function sidecar(NodeInterface $page): array {
    return $this->pageBlocks()->decode($this->workingCopy($page)->get('field_block_meta')->value);
  }

}
