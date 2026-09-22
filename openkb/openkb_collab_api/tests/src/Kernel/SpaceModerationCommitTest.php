<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_collab_api\Kernel;

use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Tests\openkb_agent\Traits\CollabClientTrait;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Symfony\Component\HttpFoundation\Response;

/**
 * The space's moderation policy, at the commit route, without a browser.
 *
 * The cookie-carried cases of the former functional suite, driven through the
 * http_kernel: what state a checkpoint lands in per space policy, who may
 * publish where, and what the status endpoint reports. The agent-token cases
 * stay functional (real OAuth belongs to the HTTP boundary).
 *
 * @group openkb_collab_api
 */
final class SpaceModerationCommitTest extends OpenkbRequestKernelTestBase {

  use CollabClientTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'custom_elements',
    'openkb_schema',
    'openkb_collab_api',
  ];

  /**
   * The space editor every write authenticates as.
   */
  private AccountInterface $editor;

  /**
   * The account the collaboration client acts as. See ::collabServer().
   */
  private ?AccountInterface $collabServer = NULL;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbReviewConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->collabClientConfigNames());
    $this->installConfig(['simple_oauth']);
    $this->installOauthKeys();
    $this->container->get('router.builder')->rebuild();
    $this->editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
  }

  /**
   * A moderated space drafts every content checkpoint.
   */
  public function testModeratedSpaceStillDrafts(): void {
    $page = $this->createPage($this->createSpace('Handbook', TRUE), 'published');

    $this->assertSame('draft', $this->commitState($page, 'Edited body.'));
    $this->assertTrue($this->reload($page)->isPublished(), 'The live revision held.');
  }

  /**
   * Content checkpoints draft everywhere — publishing is an act of its own.
   *
   * Nothing publishes unless somebody asked (ADR 0003/0004), and a checkpoint
   * asks for nothing, whatever the space. The publish that follows is the
   * payload naming the state.
   */
  public function testWikiContentCheckpointDraftsUntilThePublish(): void {
    $page = $this->createPage($this->createSpace('Wiki', FALSE), 'published');

    $this->assertSame('draft', $this->commitState($page, 'Edited body.'));
    $this->assertStringNotContainsString('Edited body.', (string) $this->reload($page)->get('field_kb_body')->value);

    // The publish goes through: the edit sits in an identified block a human
    // wrote, and a wiki space enforces only the agent step.
    $response = $this->writeCheckpoint($page, "Published body. {#b-pub}\n\nEdited body. {#b-main}", 'published');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertStringContainsString('Edited body.', (string) $this->reload($page)->get('field_kb_body')->value);
  }

  /**
   * A draft-only wiki page stays a draft until its explicit publish.
   */
  public function testFirstCheckpointKeepsTheDraftPageDraft(): void {
    $page = $this->createPage($this->createSpace('Wiki', FALSE), 'draft');

    $this->assertSame('draft', $this->commitState($page, 'First body.'));
  }

  /**
   * A space editor publishes in their own space without a global role.
   */
  public function testSpaceEditorPublishesInOwnSpace(): void {
    $page = $this->createPage($this->createSpace('Own space', TRUE), 'draft');

    // A pure state transition — the body as stored — so what this pins is the
    // roster buying publish access, not the review gate's answer to an edit.
    $response = $this->writeCheckpoint($page, 'Published body. {#b-pub}', 'published');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertTrue($this->reload($page)->isPublished());
  }

  /**
   * Text outside identified blocks refuses publication outright.
   *
   * Not a review question: an id-less block cannot be flagged or approved, so
   * no sign-off exists that could clear it — the write drafts freely, the
   * publish is refused with the structural message.
   */
  public function testIdlessRemainderRefusesPublication(): void {
    $page = $this->createPage($this->createSpace('Handbook', TRUE), 'published');
    // The seeded block is left exactly as it stands, so the remainder is the
    // one thing wrong with this body.
    $body = "Published body. {#b-pub}\n\nA paragraph carrying no id.";

    $response = $this->writeCheckpoint($page, $body);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $response = $this->writeCheckpoint($page, $body, 'published');
    $this->assertSame(422, $response->getStatusCode(), (string) $response->getContent());
    $this->assertStringContainsString('identified blocks', (string) $response->getContent());
  }

  /**
   * A published creation of id-less-only text is refused the same way.
   */
  public function testIdlessCreationRefusesPublication(): void {
    $space = $this->createSpace('Handbook', TRUE);
    $response = $this->request(
      '/openkb/node/' . $this->createPage($space, 'draft')->id() . '/commit',
      $this->editor,
      'POST',
      [
        'attributes' => [
          'field_kb_body' => ['value' => 'Fresh id-less rewrite.', 'format' => 'comark'],
          'moderation_state' => 'published',
        ],
      ],
      ['X-CSRF-Token' => $this->container->get('csrf_token')->get('rest')],
    );
    $this->assertSame(422, $response->getStatusCode(), (string) $response->getContent());
    $this->assertStringContainsString('identified blocks', (string) $response->getContent());
  }

  /**
   * A container riding the `::block{#id}` wrapper fence is an ordinary block.
   *
   * The wrapper is how the editor ids what comark has no attribute syntax for
   * (OKB-137): segmentation reads the fence id, so a table publishes through
   * the same review lane as any paragraph — no structural refusal.
   */
  public function testWrappedContainerPublishesAsIdentifiedBlock(): void {
    $page = $this->createPage($this->createSpace('Wiki', FALSE), 'published');

    $body = "Published body. {#b-pub}\n\n::block{#b-tbl}\n| a | b |\n| --- | --- |\n| 1 | 2 |\n::";
    $response = $this->writeCheckpoint($page, $body, 'published');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertStringContainsString('b-tbl', (string) $this->reload($page)->get('field_block_meta')->value);
  }

  /**
   * An id-less live body heals through an identified rewrite.
   *
   * The editor's sweep identifies what it touches, so the healing direction
   * must not wedge the publish that follows (the blocks got episodes; a wiki
   * space enforces only the agent step, and a human wrote this).
   */
  public function testIdentifyingTheRemainderUnblocksPublishing(): void {
    $page = $this->createPage($this->createSpace('Wiki', FALSE), 'published', 'Published body.');

    $response = $this->writeCheckpoint($page, 'Published body. {#b-main}', 'published');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
  }

  /**
   * The roster is the boundary: no publishing into a foreign space.
   *
   * The editor holds `use editorial transition publish` and `edit any
   * kb_page content` — every authenticated user does — and is still
   * refused, because the page sits in a space the editor has no seat in.
   */
  public function testSpaceEditorCannotPublishInForeignSpace(): void {
    $this->assertContains('edit any kb_page content', $this->recipeGrantedPermissions('authenticated'));

    $stranger = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $foreign = Space::create([
      'label' => 'Foreign',
      'read_access' => 'all_users',
      'field_moderation' => 1,
      'managers' => [['target_id' => $stranger->id()]],
    ]);
    $foreign->save();
    $page = Node::create([
      'type' => 'kb_page',
      'title' => "Somebody else's page",
      'uid' => $stranger->id(),
      'moderation_state' => 'draft',
      'field_space' => ['target_id' => $foreign->id()],
      'field_kb_body' => ['value' => 'Published body.', 'format' => 'comark'],
    ]);
    $page->save();

    $response = $this->writeCheckpoint($page, 'Not mine.', 'published');
    $this->assertSame(403, $response->getStatusCode(), (string) $response->getContent());
    $this->assertFalse($this->reload($page)->isPublished());
  }

  /**
   * A session checkpoint drafts in every space, and moves no live page.
   *
   * The client states who is acting and what they wrote; it never states a
   * publication. Both space policies land the same content write.
   */
  public function testSessionCheckpointDraftsInEverySpace(): void {
    $wiki = $this->createPage($this->createSpace('Wiki', FALSE), 'published');
    $moderated = $this->createPage($this->createSpace('Handbook', TRUE), 'published');

    $this->assertSame('draft', $this->statedCommitState($wiki, 'Edited body. {#b-main}'));
    $this->assertSame('draft', $this->statedCommitState($moderated, 'Edited body. {#b-main}'));
    $this->assertStringNotContainsString('Edited body.', (string) $this->reload($wiki)->get('field_kb_body')->value);
  }

  /**
   * A second checkpoint over a standing draft adds no revision.
   */
  public function testCheckpointOverStandingDraftAddsNoRevision(): void {
    $page = $this->createPage($this->createSpace('Handbook', TRUE), 'published');

    $this->assertSame('draft', $this->statedCommitState($page, 'Edited body. {#b-main}'));
    $revisions = $this->revisionCount($page);

    $this->assertSame('draft', $this->statedCommitState($page, 'Edited body. {#b-main}'));
    $this->assertSame($revisions, $this->revisionCount($page));
    $this->assertTrue($this->reload($page)->isPublished(), 'The live revision held.');
  }

  /**
   * A publish waiting for a review is denied, and the draft is untouched.
   *
   * A wiki space enforces the agent step, so an agent's block waits for a
   * sign-off there exactly as a peer-reviewed one does in a moderated space.
   * The refusal writes nothing: the draft the editor saved is still there.
   */
  public function testWikiPublishUnderReviewIsDenied(): void {
    $page = $this->createPage($this->createSpace('Wiki', FALSE), 'published');

    $this->assertSame('draft', $this->statedCommitState($page, 'Edited body. {#b-main}', 'claude'));
    $vid = (int) $this->workingCopy($this->reload($page))->getRevisionId();

    $response = $this->writeCheckpoint($page, "Published body. {#b-pub}\n\nEdited body. {#b-main}", 'published');
    $this->assertSame(422, $response->getStatusCode(), (string) $response->getContent());

    $this->assertStringNotContainsString('Edited body.', (string) $this->reload($page)->get('field_kb_body')->value);
    $working_copy = $this->workingCopy($this->reload($page));
    $this->assertSame($vid, (int) $working_copy->getRevisionId(), 'Nothing was written.');
    $this->assertStringContainsString(
      'Edited body.',
      (string) $working_copy->get('field_kb_body')->value,
      'The editor keeps their text.',
    );
  }

  /**
   * A moderated space refuses the same publish rather than holding it.
   *
   * There a second act is coming — the publish after the review — so a
   * refusal names something its caller can do.
   */
  public function testModeratedPublishUnderReviewIsRefused(): void {
    $page = $this->createPage($this->createSpace('Handbook', TRUE), 'published');

    $this->assertSame('draft', $this->statedCommitState($page, 'Edited body. {#b-main}', 'claude'));
    $response = $this->writeCheckpoint($page, "Published body. {#b-pub}\n\nEdited body. {#b-main}", 'published');
    $this->assertSame(422, $response->getStatusCode(), (string) $response->getContent());
  }

  /**
   * Text with no review lane is refused, pending block or not.
   *
   * No sign-off can clear it, so parking it in review would wait forever: it
   * is the one publish the editor has to act on themselves. The refusal
   * writes nothing, the working copy included.
   */
  public function testIdlessRemainderRefusedWhileBlockPending(): void {
    $page = $this->createPage($this->createSpace('Wiki', FALSE), 'published');

    $this->assertSame('draft', $this->statedCommitState($page, 'Edited body. {#b-main}', 'claude'));
    $response = $this->writeCheckpoint($page, "Edited body. {#b-main}\n\nAn id-less afterthought.", 'published');
    $this->assertSame(422, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame(
      'draft',
      (string) $this->workingCopy($this->reload($page))->get('moderation_state')->value,
    );
  }

  /**
   * The moderation state a checkpoint landed in.
   */
  private function commitState(NodeInterface $page, string $body): string {
    $response = $this->writeCheckpoint($page, $body);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    return (string) $this->decode($response)['data']['attributes']['moderation_state'];
  }

  /**
   * The state a collaboration-client checkpoint acting as the editor landed in.
   */
  private function statedCommitState(NodeInterface $page, string $body, ?string $via = NULL): string {
    $response = $this->statedCheckpoint($page, $body, $via);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    return (string) $this->decode($response)['data']['attributes']['moderation_state'];
  }

  /**
   * POSTs a checkpoint on the collaboration client's own connection.
   *
   * Acts as the editor and names no state of its own.
   */
  private function statedCheckpoint(NodeInterface $page, string $body, ?string $via = NULL): Response {
    return $this->request(
      '/openkb/node/' . $page->id() . '/commit',
      NULL,
      'POST',
      [
        'attributes' => ['field_kb_body' => ['value' => $body, 'format' => 'comark']],
        'session' => [
          'acting_uid' => (int) $this->editor->id(),
          // Both: these bodies replace the seeded block, and the collaboration
          // server states every block whose content moved — the one that left
          // the document included, or its removal lands unaccounted (ADR 0017).
          'blocks' => [
            'b-main' => [['uid' => (int) $this->editor->id(), 'via' => $via]],
            'b-pub' => [['uid' => (int) $this->editor->id(), 'via' => $via]],
          ],
        ],
      ],
      $this->collabBearer($this->collabServer()),
    );
  }

  /**
   * The account the collaboration client acts as, created on first use.
   */
  private function collabServer(): AccountInterface {
    return $this->collabServer ??= $this->createUser([
      ...$this->recipeGrantedPermissions('authenticated'),
      'use collaboration api',
    ]);
  }

  /**
   * Sends the payload a checkpoint sends, as the space editor.
   */
  private function writeCheckpoint(NodeInterface $page, string $body, ?string $state = NULL): Response {
    $attributes = ['field_kb_body' => ['value' => $body, 'format' => 'comark']];
    if ($state !== NULL) {
      $attributes['moderation_state'] = $state;
    }
    return $this->request(
      '/openkb/node/' . $page->id() . '/commit',
      $this->editor,
      'POST',
      ['attributes' => $attributes],
      // Generator and validator share the session_manager.metadata_bag
      // service in-process, so this token is the one the route accepts.
      ['X-CSRF-Token' => $this->container->get('csrf_token')->get('rest')],
    );
  }

  /**
   * Creates a space with the test editor on its roster.
   */
  private function createSpace(string $name, bool $moderated): SpaceInterface {
    $space = Space::create([
      'label' => $name,
      'read_access' => 'all_users',
      'field_moderation' => $moderated ? 1 : 0,
      'managers' => [['target_id' => $this->editor->id()]],
    ]);
    $space->save();
    return $space;
  }

  /**
   * Builds a page in a space; direct save skips validation on purpose.
   */
  private function createPage(SpaceInterface $space, string $state, string $body = 'Published body. {#b-pub}'): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Space page',
      'uid' => $this->editor->id(),
      'moderation_state' => $state,
      'field_space' => ['target_id' => $space->id()],
      'field_kb_body' => ['value' => $body, 'format' => 'comark'],
    ]);
    $page->save();
    // Seeded content owes no review: presave stamped the creation (its
    // remainder included), and the fixture clears that by fiat.
    $page->set('field_block_meta', NULL);
    $page->setNewRevision(FALSE);
    $page->save();
    return $page;
  }

  /**
   * How many revisions the page has.
   */
  private function revisionCount(NodeInterface $page): int {
    return (int) $this->container->get('entity_type.manager')->getStorage('node')
      ->getQuery()
      ->accessCheck(FALSE)
      ->allRevisions()
      ->condition('nid', $page->id())
      ->count()
      ->execute();
  }

  /**
   * The page's latest revision — what the editor's text landed on.
   */
  private function workingCopy(NodeInterface $page): NodeInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    return $latest;
  }

  /**
   * The page as storage now holds it.
   */
  private function reload(NodeInterface $page): NodeInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    /** @var \Drupal\node\NodeInterface $reloaded */
    $reloaded = $storage->load($page->id());
    return $reloaded;
  }

}
