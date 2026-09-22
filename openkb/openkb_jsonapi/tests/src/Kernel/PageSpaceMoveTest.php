<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_jsonapi\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\taxonomy\Entity\Term;
use Symfony\Component\HttpFoundation\Response;

/**
 * Moving a page to another space, over `POST /openkb/node/{node}/space`.
 *
 * The contract this asserts is the one the listings depend on: after a move the
 * page is in the target space for *every* reader. On a published page
 * carrying a forward draft that means both revisions — the default one the
 * sidebar, the space landing page and search read, and the draft that becomes
 * default on the next publish. A move that only wrote one of them would either
 * not show up at all or silently revert when the draft lands.
 *
 * The carrier is the session cookie plus its CSRF token, so the route answers
 * through the http_kernel and this is a kernel test.
 *
 * @group openkb_jsonapi
 */
final class PageSpaceMoveTest extends OpenkbRequestKernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'custom_elements',
    // openkb_jsonapi depends on openkb_collab_api.
    'openkb_schema',
    'openkb_collab_api',
    'openkb_jsonapi',
  ];

  /**
   * The space a page starts in.
   */
  private Space $origin;

  /**
   * The space a page is moved to.
   */
  private Space $target;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->config('jsonapi.settings')->set('read_only', FALSE)->save();
    $this->container->get('router.builder')->rebuild();

    $this->origin = $this->createSpace('Engineering');
    $this->target = $this->createSpace('Product');
  }

  /**
   * A space every colleague can read, with an empty editor roster.
   */
  private function createSpace(string $name): Space {
    $space = Space::create([
      'label' => $name,
      'read_access' => 'all_users',
    ]);
    $space->save();
    return $space;
  }

  /**
   * An account on both spaces' editor rosters.
   *
   * A move is a write in the space it leaves and in the one it joins, and
   * update access inside a space is its roster (openkb_space_access) — so an
   * account moving pages between these two is on both.
   */
  private function createEditor(): AccountInterface {
    $account = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    foreach ([$this->origin, $this->target] as $space) {
      $space->get('managers')->appendItem(['target_id' => $account->id()]);
      $space->save();
    }
    return $account;
  }

  /**
   * A move reaches the published revision and the draft on top of it.
   *
   * Neither existing write path can do this: a commit payload without a
   * moderation state drafts, so the reassignment would never reach the
   * published revision the listings read, and JSON:API refuses any write at all
   * once a forward draft exists (core #2795279).
   */
  public function testMoveWritesDefaultRevisionAndForwardDraft(): void {
    $editor = $this->createEditor();
    $page = $this->createPublishedPage($editor->id());
    $published_vid = (int) $page->getRevisionId();
    $this->writeForwardDraft($page, $editor);
    $draft_vid = (int) $this->nodeStorage()->getLatestRevisionId($page->id());
    $this->assertNotSame($published_vid, $draft_vid);

    $response = $this->postMove($page, $editor, ['space' => $this->target->uuid()]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $result = Json::decode((string) $response->getContent());
    $this->assertSame($this->target->uuid(), $result['space']['id']);
    $this->assertSame('Product', $result['space']['name']);

    $storage = $this->nodeStorage();

    // The default revision: new space, still published, still the same
    // revision, body untouched.
    /** @var \Drupal\node\NodeInterface $default */
    $default = $storage->load($page->id());
    $this->assertSame($this->target->id(), $default->get('field_space')->target_id);
    $this->assertTrue($default->isPublished());
    $this->assertSame($published_vid, (int) $default->getRevisionId());
    $this->assertSame('Published body.', $default->get('field_kb_body')->value);

    // The forward draft: new space too, and still a non-default draft — so
    // publishing it will not move the page back.
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($draft_vid);
    $this->assertSame($this->target->id(), $latest->get('field_space')->target_id);
    $this->assertFalse($latest->isDefaultRevision());
    $this->assertSame('draft', $latest->get('moderation_state')->value);
    $this->assertSame('Draft body.', $latest->get('field_kb_body')->value);

    // Placement is not an editorial act, so it adds no revision.
    $this->assertCount(2, $storage->getQuery()
      ->accessCheck(FALSE)
      ->allRevisions()
      ->condition('nid', $page->id())
      ->execute());
  }

  /**
   * A move on a page with no draft writes the one revision it has.
   */
  public function testMoveWithoutForwardDraft(): void {
    $editor = $this->createEditor();
    $page = $this->createPublishedPage($editor->id());

    $response = $this->postMove($page, $editor, ['space' => $this->target->uuid()]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame($this->target->id(), $default->get('field_space')->target_id);
    $this->assertTrue($default->isPublished());
    $this->assertCount(1, $this->nodeStorage()->getQuery()
      ->accessCheck(FALSE)
      ->allRevisions()
      ->condition('nid', $page->id())
      ->execute());
  }

  /**
   * An entity that is not a space is no place a page can move to.
   *
   * A tag term exists and carries a UUID, and moving a page "into" it
   * would leave the field holding a value the reference constraint rejects —
   * so the target is resolved as a space before anything is written.
   */
  public function testTagTargetIsRejected(): void {
    $editor = $this->createEditor();
    $page = $this->createPublishedPage($editor->id());
    $tag = Term::create(['vid' => 'kb_tags', 'name' => 'Not a space']);
    $tag->save();

    $response = $this->postMove($page, $editor, ['space' => $tag->uuid()]);
    $this->assertSame(404, $response->getStatusCode(), (string) $response->getContent());

    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame($this->origin->id(), $default->get('field_space')->target_id);
  }

  /**
   * A UUID naming no entity at all is rejected the same way, and moves nothing.
   */
  public function testUnknownSpaceUuidIsRejected(): void {
    $editor = $this->createEditor();
    $page = $this->createPublishedPage($editor->id());

    $response = $this->postMove($page, $editor, ['space' => '11111111-2222-3333-4444-555555555555']);
    $this->assertSame(404, $response->getStatusCode(), (string) $response->getContent());

    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame($this->origin->id(), $default->get('field_space')->target_id);
  }

  /**
   * A body that names no space is a bad request, and moves nothing.
   */
  public function testMalformedPayloadIsRejected(): void {
    $editor = $this->createEditor();
    $page = $this->createPublishedPage($editor->id());

    $response = $this->postMove($page, $editor, ['nothing' => 'useful']);
    $this->assertSame(400, $response->getStatusCode(), (string) $response->getContent());

    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame($this->origin->id(), $default->get('field_space')->target_id);
  }

  /**
   * Moving somebody else's page needs update access to it.
   *
   * The site-wide grant on `authenticated` is not a seat in the space, so a
   * reader is refused by the route's own entity-access gate — the frontend
   * hides the action behind the same signal, but the enforcement is here.
   */
  public function testMoveNeedsUpdateAccess(): void {
    $owner = $this->createEditor();
    $reader = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($owner->id());

    $response = $this->postMove($page, $reader, ['space' => $this->target->uuid()]);
    $this->assertSame(403, $response->getStatusCode(), (string) $response->getContent());

    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame($this->origin->id(), $default->get('field_space')->target_id);
  }

  /**
   * The endpoint is the kb_page placement surface and nothing else.
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

    $response = $this->postMove($page, $editor, ['space' => $this->target->uuid()]);
    $this->assertSame(404, $response->getStatusCode(), (string) $response->getContent());
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
   * Builds a Published page in the origin space, seeded past validation.
   */
  private function createPublishedPage(string|int $uid): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Placed page',
      'uid' => $uid,
      'moderation_state' => 'published',
      'field_space' => ['target_id' => $this->origin->id()],
      'field_kb_body' => [
        'value' => 'Published body.',
        'format' => 'comark',
      ],
    ]);
    $page->save();
    return $page;
  }

  /**
   * Leaves a forward draft on the page, the way a checkpoint does.
   */
  private function writeForwardDraft(NodeInterface $page, AccountInterface $user): void {
    $response = $this->post(
      '/openkb/node/' . $page->id() . '/commit',
      $user,
      ['attributes' => ['field_kb_body' => ['value' => 'Draft body.', 'format' => 'comark']]],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
  }

  /**
   * POSTs a move payload as the given user.
   */
  private function postMove(NodeInterface $page, AccountInterface $user, array $payload): Response {
    return $this->post('/openkb/node/' . $page->id() . '/space', $user, $payload);
  }

  /**
   * POSTs a JSON payload to an openkb write route, over session and CSRF.
   *
   * @param string $path
   *   The route path.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   * @param array $payload
   *   The JSON payload.
   *
   * @return \Symfony\Component\HttpFoundation\Response
   *   The response.
   */
  private function post(string $path, AccountInterface $user, array $payload): Response {
    return $this->request(
      $path,
      $user,
      'POST',
      $payload,
      // Generator and validator share the session_manager.metadata_bag
      // service in-process, so this token is the one the route accepts.
      ['X-CSRF-Token' => $this->container->get('csrf_token')->get('rest')],
    );
  }

}
