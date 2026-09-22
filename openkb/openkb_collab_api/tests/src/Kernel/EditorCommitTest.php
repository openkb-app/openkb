<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_collab_api\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\taxonomy\Entity\Term;
use Symfony\Component\HttpFoundation\Response;

/**
 * A non-admin editor can commit ("Save to history") a comark body.
 *
 * The commit path is `POST /openkb/node/{node}/commit` under the editing
 * user's own credentials. The user carries exactly the permissions the shipped
 * recipe grants the authenticated role — read from the actual recipe.yml, so a
 * missing grant (e.g. the 'use editorial transition create_new_draft' the
 * moderated commit needs) fails this test the same way it 422s a real editor.
 *
 * kb_page is moderated (the shipped `editorial` workflow). A content payload
 * names no moderation state, and the route decides it: on a moderated page,
 * draft — so a checkpoint on a Published node lands as a non-default *forward*
 * draft revision and the live published revision is untouched, the OKB-64
 * collab/moderation contract. A payload that does name a state is a deliberate
 * editorial act and is honoured as sent. The route exists because
 * that contract cannot be met over JSON:API: it refuses every write on an
 * entity that has a working copy (core #2795279), and it bases new revisions
 * on the default revision, which would revert what earlier checkpoints wrote
 * into the draft.
 *
 * The carrier is the session cookie plus its CSRF token, so the route answers
 * through the http_kernel and this is a kernel test.
 *
 * @group openkb_collab_api
 */
final class EditorCommitTest extends OpenkbRequestKernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'custom_elements',
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
    // Moderation depends on the kb_page node type existing first.
    $this->importRecipeConfig($this->kbModerationConfigNames());

    // Mirrors the recipe's config action — the editing surfaces read revisions
    // over JSON:API, whose routes exist only with read_only off.
    $this->config('jsonapi.settings')->set('read_only', FALSE)->save();
    $this->container->get('router.builder')->rebuild();
  }

  /**
   * A recipe-granted editor's checkpoint lands as a forward draft.
   *
   * This is the OKB-64 collab/moderation contract, over the payload a
   * checkpoint really sends — content, no state. The route drafts it, so a
   * checkpoint on a Published node writes a non-default draft revision (the
   * published→draft `create_new_draft` transition the authenticated grant
   * covers) and never un-publishes the live page.
   */
  public function testNonAdminCommitCreatesForwardDraft(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());
    $published_vid = $page->getRevisionId();
    $this->assertTrue($page->isPublished());

    $response = $this->writeCheckpoint($page, $editor, NULL, 'Draft body.');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    // The response is the written revision as JSON:API renders it — the route
    // is core's entity resource with a different revision base, not a bespoke
    // endpoint with a bespoke response.
    $result = Json::decode((string) $response->getContent());
    $this->assertSame('draft', $result['data']['attributes']['moderation_state']);
    $this->assertSame('Draft body.', $result['data']['attributes']['field_kb_body']['value']);

    $storage = $this->nodeStorage();

    // The default (public) revision is untouched: still published, old body.
    /** @var \Drupal\node\NodeInterface $default */
    $default = $storage->load($page->id());
    $this->assertTrue($default->isPublished());
    $this->assertSame('Published body.', $default->get('field_kb_body')->value);
    $this->assertSame($published_vid, $default->getRevisionId());

    // A new forward draft revision carries the edit, attributed to the editor.
    $latest_vid = $storage->getLatestRevisionId($page->id());
    $this->assertNotSame($published_vid, $latest_vid);
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($latest_vid);
    $this->assertFalse($latest->isDefaultRevision());
    $this->assertFalse($latest->isPublished());
    $this->assertSame('draft', $latest->get('moderation_state')->value);
    $this->assertSame('Draft body.', $latest->get('field_kb_body')->value);
    $this->assertSame($editor->id(), $latest->getRevisionUser()->id());
  }

  /**
   * A checkpoint names no text format; Drupal fills the field's own in.
   *
   * The wire half of the contract the presave carries — the frontend sends a
   * body value and nothing else, so nothing outside Drupal has to know which
   * format bodies are authored in.
   */
  public function testCommitWithoutFormatStoresTheConfiguredOne(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());

    $response = $this->postCommit($page, $editor, [
      'attributes' => ['field_kb_body' => ['value' => 'Formatless draft.']],
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    $this->assertSame('Formatless draft.', $latest->get('field_kb_body')->value);
    $this->assertSame('comark', $latest->get('field_kb_body')->format);
  }

  /**
   * A session writes many checkpoints, not one.
   *
   * The reason this route exists: over JSON:API the second checkpoint 400s
   * ("Updating a resource object that has a working copy is not yet
   * supported"), because the first one made the latest revision non-default —
   * so a collab session could write exactly one checkpoint per page and
   * then wedged. Each checkpoint here must add one more forward draft with the
   * published revision still untouched.
   */
  public function testConsecutiveCheckpointsKeepCommitting(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());
    $published_vid = $page->getRevisionId();

    foreach (['First draft.', 'Second draft.', 'Third draft.'] as $body) {
      $response = $this->writeCheckpoint($page, $editor, NULL, $body);
      $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    }

    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $default */
    $default = $storage->load($page->id());
    $this->assertTrue($default->isPublished());
    $this->assertSame($published_vid, $default->getRevisionId());

    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    $this->assertFalse($latest->isDefaultRevision());
    $this->assertSame('Third draft.', $latest->get('field_kb_body')->value);
    // Seed + three checkpoints.
    $revisions = $storage->getQuery()
      ->accessCheck(FALSE)
      ->allRevisions()
      ->condition('nid', $page->id())
      ->execute();
    $this->assertCount(4, $revisions);
  }

  /**
   * A partial checkpoint merges onto the working copy, never onto the default.
   *
   * The revert hazard that ruled out relaxing core's guard: checkpoints only
   * send the fields they saw change, so a body-only checkpoint whose base was
   * the *published* revision would silently drop the frontmatter an earlier
   * checkpoint wrote into the draft. Basing every write on the latest revision
   * is what makes a partial payload safe.
   */
  public function testPartialCheckpointKeepsEarlierDraftFields(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());

    // Checkpoint 1: a frontmatter field moves, into the forward draft.
    $response = $this->writeCheckpoint($page, $editor, NULL, 'Draft body.', [
      'field_summary' => 'Summary written by the first checkpoint.',
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    // Checkpoint 2: body only — the field is unchanged, so it is not resent.
    $response = $this->writeCheckpoint($page, $editor, NULL, 'Draft body, take two.');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    $this->assertSame('Draft body, take two.', $latest->get('field_kb_body')->value);
    $this->assertSame('Summary written by the first checkpoint.', $latest->get('field_summary')->value);

    // …and the published revision still carries neither.
    /** @var \Drupal\node\NodeInterface $default */
    $default = $storage->load($page->id());
    $this->assertSame('Published body.', $default->get('field_kb_body')->value);
    $this->assertTrue($default->get('field_summary')->isEmpty());
  }

  /**
   * A never-published page's draft is its own default revision.
   *
   * New pages have no published revision to hide behind, so the draft IS
   * what the author's read and edit surfaces resolve — through the same
   * working-copy lookup a page with a forward draft uses. A reviewer sees
   * it through the same `authenticated` grants — there is no editorial role
   * above them.
   */
  public function testNewPageDraftIsReadableByAuthorAndReviewer(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $reviewer = $this->createUser($this->recipeGrantedPermissions('authenticated'));

    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Brand new page',
      'uid' => $editor->id(),
      'moderation_state' => 'draft',
      'field_kb_body' => ['value' => 'First draft.'],
    ]);
    $page->save();
    $this->assertFalse($page->isPublished());
    $this->assertTrue($page->isDefaultRevision());

    foreach ([$editor, $reviewer] as $account) {
      $document = $this->readWorkingCopy($page, $account);
      $this->assertSame('First draft.', $document['data']['attributes']['field_kb_body']['value']);
      $this->assertSame('draft', $document['data']['attributes']['moderation_state']);
    }

    // And the author can go on committing into it.
    $response = $this->writeCheckpoint($page, $editor, NULL, 'Second draft.');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    $this->assertTrue($latest->isDefaultRevision());
    $this->assertSame('Second draft.', $latest->get('field_kb_body')->value);
  }

  /**
   * The editing surfaces read back the draft they just wrote.
   *
   * The frontend hydrates the editor — and runs the commit service's
   * concurrency check — against `?resourceVersion=rel:working-copy`, because
   * the default revision is the published one and knows nothing of the forward
   * draft. JSON:API gates a non-default revision on three separate checks
   * (revision permission, view access to the unpublished revision,
   * content_moderation's LatestRevisionCheck), so this fails the moment the
   * recipe stops granting all three.
   */
  public function testEditorReadsOwnWorkingCopy(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());
    $this->writeCheckpoint($page, $editor, NULL, 'Draft body.');

    $document = $this->readWorkingCopy($page, $editor);
    $this->assertSame('Draft body.', $document['data']['attributes']['field_kb_body']['value']);
    $this->assertSame('draft', $document['data']['attributes']['moderation_state']);
  }

  /**
   * A reviewer reads a draft on content they do not own.
   *
   * The `authenticated` grants make the review flow usable: without
   * 'view any unpublished content' the LatestRevisionCheck falls back to the
   * owner branch and a reviewer 403s on every draft but their own. Which
   * drafts an account may actually read is the space roster's call
   * (openkb_space_access); the pages here carry no space, so the site-wide
   * grants are the whole answer.
   */
  public function testReviewerReadsAnotherEditorsWorkingCopy(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $reviewer = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());
    $this->writeCheckpoint($page, $editor, NULL, 'Draft body.');

    $document = $this->readWorkingCopy($page, $reviewer);
    $this->assertSame('Draft body.', $document['data']['attributes']['field_kb_body']['value']);
  }

  /**
   * Writing content never publishes, not even for someone who may.
   *
   * The state decision is the resource's, not the caller's permission set: a
   * content payload from an editor who *holds* the `publish` transition still
   * drafts. Were the state simply left out, the entity would be re-saved in the
   * state it loaded with — publishing whatever the session happened to contain,
   * straight onto the live page, for exactly this user.
   */
  public function testContentWriteDoesNotPublishForPublisher(): void {
    $publisher = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($publisher->id());
    $published_vid = $page->getRevisionId();

    $response = $this->writeCheckpoint($page, $publisher, NULL, 'Body without a state.');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame(
      'draft',
      Json::decode((string) $response->getContent())['data']['attributes']['moderation_state'],
    );

    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertTrue($default->isPublished());
    $this->assertSame('Published body.', $default->get('field_kb_body')->value);
    $this->assertSame($published_vid, $default->getRevisionId());
  }

  /**
   * A named state is honoured, and answers to the workflow.
   *
   * The deliberate editorial act — the editor's Publish — is a payload that
   * names its state. Authorization for it is write access to the page, not
   * a role: the recipe grants the publish transition to `authenticated`, so an
   * ordinary editor publishes the page they may edit. What the state still
   * answers to is the workflow itself, which is what the `moderation_state`
   * constraint enforces on every write.
   */
  public function testNamedStateIsHonouredAndTransitionChecked(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $this->assertContains('use editorial transition publish', $this->recipeGrantedPermissions('authenticated'));
    // A draft whose content already answers for nothing: the named publish
    // is a pure transition, so what this pins is the state being honoured
    // and workflow-checked — not the review gate's answer to an edit.
    $page = $this->createDraftPage($editor->id());

    $response = $this->writeCheckpoint($page, $editor, 'published', 'Draft body.');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $default */
    $default = $storage->load($page->id());
    $this->assertTrue($default->isPublished());
    $this->assertSame('Draft body.', $default->get('field_kb_body')->value);

    // A state the workflow does not define is refused, and nothing is written:
    // the constraint runs on every commit that names a state.
    $live_vid = (int) $storage->getLatestRevisionId($page->id());
    $response = $this->writeCheckpoint($page, $editor, 'archived', 'Into the void.');
    $this->assertSame(422, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame($live_vid, (int) $this->nodeStorage()->getLatestRevisionId($page->id()));
  }

  /**
   * A pre-existing violation elsewhere does not wedge the commit lane.
   *
   * References go dangling when their target is deleted, and the page keeps
   * the stale value until something rewrites it. Validating the whole entity
   * would then reject every future body checkpoint over a field the editor
   * never touched — the session could never save again. Only the fields a
   * payload writes are that payload's to answer for (plus the moderation
   * state, whose constraint is the transition check).
   */
  public function testPreexistingViolationElsewhereDoesNotBlockTheBody(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());

    // A tag that exists at save time and is gone afterwards.
    $term = Term::create(['vid' => 'kb_tags', 'name' => 'Doomed tag']);
    $term->save();
    $page->set('field_tags', [$term->id()]);
    $page->save();
    $term->delete();

    // Sanity: the page really is invalid now, on a field nobody is writing.
    $this->assertGreaterThan(0, $page->validate()->count());

    $response = $this->writeCheckpoint($page, $editor, NULL, 'Draft body.');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    $this->assertSame('Draft body.', $latest->get('field_kb_body')->value);
  }

  /**
   * Ownership and publication are not an editor's to write here.
   *
   * There is no allow-list behind this: the endpoint is core's JSON:API entity
   * resource, so ownership and publication are refused by the same per-field
   * PATCH access check that refuses them on `/jsonapi` — 403, pointing at the
   * field, because being denied a field is an authorization verdict and not
   * something the editor could fix by sending a better value.
   */
  public function testUnwritableAttributeIsRejected(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $other = $this->createUser();
    $page = $this->createPublishedPage($editor->id());

    // The owner is an entity reference, so it rides as a relationship — the
    // member it belongs in is core's to decide, and it says so itself when a
    // payload puts it in the wrong one.
    $response = $this->postCommit($page, $editor, [
      'relationships' => ['uid' => ['data' => ['type' => 'user--user', 'id' => $other->uuid()]]],
    ]);
    $this->assertSame(403, $response->getStatusCode(), (string) $response->getContent());
    $errors = Json::decode((string) $response->getContent())['errors'];
    $this->assertSame('/data/attributes/uid', $errors[0]['source']['pointer']);

    // Nothing was written.
    $this->assertSame(
      (int) $page->getRevisionId(),
      (int) $this->nodeStorage()->getLatestRevisionId($page->id()),
    );

    // Same for the publication flag, which is the workflow's to move.
    $response = $this->postCommit($page, $editor, [
      'attributes' => ['status' => 0],
    ]);
    $this->assertSame(403, $response->getStatusCode(), (string) $response->getContent());
    $this->assertTrue($this->nodeStorage()->load($page->id())->isPublished());
  }

  /**
   * An unresolvable reference is refused, never silently dropped.
   *
   * A commit whose reference target is gone is JSON:API's "related resource
   * could not be found" — the frontend's field extenders resolve references
   * before they build a payload, so reaching this is already a broken lane,
   * not a value an editor can correct in the form.
   */
  public function testUnresolvableReferenceIsRejected(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());

    $response = $this->postCommit($page, $editor, [
      'attributes' => ['moderation_state' => 'draft'],
      'relationships' => [
        'field_tags' => [
          'data' => [['type' => 'taxonomy_term--kb_tags', 'id' => '11111111-2222-3333-4444-555555555555']],
        ],
      ],
    ]);
    $this->assertSame(404, $response->getStatusCode(), (string) $response->getContent());
    $errors = Json::decode((string) $response->getContent())['errors'];
    $this->assertStringContainsString('could not be found', $errors[0]['detail']);

    // Nothing was written.
    $this->assertSame(
      (int) $page->getRevisionId(),
      (int) $this->nodeStorage()->getLatestRevisionId($page->id()),
    );
  }

  /**
   * The endpoint is the kb_page commit surface and nothing else.
   *
   * Entity access already keeps another bundle safe, so this asserts the
   * explicit contract rather than the incidental one: the user here *may*
   * update the page — the route's `_entity_access` gate passes — and the
   * controller still refuses it. A 403 would mean the bundle check never ran.
   */
  public function testOtherBundlesAreRejected(): void {
    NodeType::create(['type' => 'page', 'name' => 'Basic page'])->save();
    $editor = $this->createUser(
      [...$this->recipeGrantedPermissions('authenticated'), 'edit any page content'],
    );
    $page = Node::create([
      'type' => 'page',
      'title' => 'Not a knowledge-base page',
      'uid' => $editor->id(),
    ]);
    $page->save();

    $response = $this->postCommit($page, $editor, [
      'attributes' => ['title' => 'Renamed through the commit route'],
    ]);
    $this->assertSame(404, $response->getStatusCode(), (string) $response->getContent());

    // Nothing was written.
    $this->assertSame(
      (int) $page->getRevisionId(),
      (int) $this->nodeStorage()->getLatestRevisionId($page->id()),
    );
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
   * A draft-only page whose body a pure-transition publish will carry.
   */
  private function createDraftPage(string|int $uid): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Collab page',
      'uid' => $uid,
      'moderation_state' => 'draft',
      'field_kb_body' => ['value' => 'Draft body.'],
    ]);
    $page->save();
    if ($page->hasField('field_block_meta')) {
      $page->set('field_block_meta', NULL);
      $page->setNewRevision(FALSE);
      $page->save();
    }
    return $page;
  }

  /**
   * Builds a Published page owned by the given user, seeded past validation.
   *
   * The raw `status` field is ignored under content_moderation, so the state
   * must be set explicitly. Direct ->save() skips entity validation, so no
   * transition permission is needed to seed it.
   */
  private function createPublishedPage(string|int $uid): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Collab page',
      'uid' => $uid,
      'moderation_state' => 'published',
      'field_kb_body' => ['value' => 'Published body.'],
    ]);
    $page->save();
    if ($page->hasField('field_block_meta')) {
      $page->set('field_block_meta', NULL);
      $page->setNewRevision(FALSE);
      $page->save();
    }
    return $page;
  }

  /**
   * Sends the commit payload a checkpoint sends, as the given user.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   * @param string|null $state
   *   The moderation state to send, or NULL to omit the field entirely.
   * @param string $body
   *   The comark body to write.
   * @param array $fields
   *   Extra scalar attributes, as the fields extender would produce them.
   *
   * @return \Symfony\Component\HttpFoundation\Response
   *   The response.
   */
  private function writeCheckpoint(
    NodeInterface $page,
    AccountInterface $user,
    ?string $state,
    string $body,
    array $fields = [],
  ): Response {
    $attributes = ['field_kb_body' => ['value' => $body]] + $fields;
    if ($state !== NULL) {
      $attributes['moderation_state'] = $state;
    }
    return $this->postCommit($page, $user, ['attributes' => $attributes]);
  }

  /**
   * POSTs a raw commit payload as the given user, over their session and CSRF.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   * @param array $payload
   *   The commit payload.
   *
   * @return \Symfony\Component\HttpFoundation\Response
   *   The response.
   */
  private function postCommit(
    NodeInterface $page,
    AccountInterface $user,
    array $payload,
  ): Response {
    return $this->request(
      '/openkb/node/' . $page->id() . '/commit',
      $user,
      'POST',
      $payload,
      // Generator and validator share the session_manager.metadata_bag
      // service in-process, so this token is the one the route accepts.
      ['X-CSRF-Token' => $this->container->get('csrf_token')->get('rest')],
    );
  }

  /**
   * Reads the page's working copy over JSON:API as the given user.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to read.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   *
   * @return array
   *   The decoded JSON:API document.
   */
  private function readWorkingCopy(NodeInterface $page, AccountInterface $user): array {
    $response = $this->request(
      '/jsonapi/node/kb_page/' . $page->uuid() . '?resourceVersion=rel:working-copy',
      $user,
      'GET',
      NULL,
      ['Accept' => 'application/vnd.api+json'],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    return Json::decode((string) $response->getContent());
  }

}
