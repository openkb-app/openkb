<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_jsonapi\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Symfony\Component\HttpFoundation\Response;

/**
 * Reading the working copy over JSON:API `?resourceVersion=rel:working-copy`.
 *
 * The editor hydrates from the working copy — the forward draft a checkpoint
 * leaves on a published page. The read is gated by the space's editor
 * roster, not by who owns the node: a shared space is a place where editors
 * work on each other's pages. Core's revision checks
 * (\Drupal\content_moderation\Access\LatestRevisionCheck) are bare permission
 * checks, opened by the recipe's `view any unpublished content` grant on
 * `authenticated`; whose draft an account may actually read is decided by
 * openkb_space_access, which forbids working-copy view without space update
 * access. This suite pins both halves: an editor who is not the owner may
 * read, and a reader holding every site-wide permission may not.
 *
 * The carrier is the session cookie, so the route answers through the
 * http_kernel and this is a kernel test.
 *
 * @group openkb_jsonapi
 */
final class WorkingCopyReadTest extends OpenkbRequestKernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'custom_elements',
    // openkb_jsonapi's resources inherit the commit resource, which lives in
    // openkb_collab_api.
    'openkb_schema',
    'openkb_collab_api',
    'openkb_jsonapi',
  ];

  /**
   * A space every colleague can read, with an editor roster.
   */
  private Space $space;

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

    $this->space = Space::create([
      'label' => 'Engineering',
      'read_access' => 'all_users',
    ]);
    $this->space->save();
  }

  /**
   * An editor may read the working copy of a page they do not own.
   *
   * The scenario the demo hits: a page owned by whoever seeded it carries
   * a forward draft, and a *different* editor on the space roster opens it.
   * Their roster gives update access, which is what openkb_space_access
   * requires before it lets the revision read through.
   */
  public function testEditorReadsWorkingCopyOfPageTheyDoNotOwn(): void {
    $author = $this->createEditor();
    $editor = $this->createEditor();
    $page = $this->createPublishedPage($author->id());
    // A colleague's checkpoint leaves the forward draft this read serves.
    $this->writeForwardDraft($page, $editor, 'Draft body only the roster may read.');
    $this->assertNotSame((int) $author->id(), (int) $editor->id());

    $response = $this->readWorkingCopy($page, $editor);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $document = Json::decode((string) $response->getContent());
    // It is the draft that comes back, not the published default revision.
    $this->assertSame('draft', $document['data']['attributes']['moderation_state']);
    $this->assertStringContainsString('Draft body only the roster may read.', $document['data']['attributes']['field_kb_body']['value']);
  }

  /**
   * A reader who cannot write the space cannot read its drafts.
   *
   * The reader holds every site-wide grant the recipe hands `authenticated`,
   * `view any unpublished content` included — a forward draft is still the
   * editors' until it is published, the same boundary the grant records draw
   * for an unpublished page. The roster is the answer, not the permission.
   */
  public function testReaderOffTheRosterCannotReadTheWorkingCopy(): void {
    $editor = $this->createEditor();
    $reader = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createPublishedPage($editor->id());
    $this->writeForwardDraft($page, $editor, 'Draft body.');

    $response = $this->readWorkingCopy($page, $reader);
    $this->assertSame(403, $response->getStatusCode(), (string) $response->getContent());
  }

  /**
   * Ownership does not outlive the roster seat.
   *
   * An author taken off the roster keeps the published page and loses the
   * draft: the seat is the whole answer, and the space rule forbids the read
   * even for the account that wrote it.
   */
  public function testOwnerOffTheRosterCannotReadTheWorkingCopy(): void {
    $author = $this->createEditor();
    $page = $this->createPublishedPage($author->id());
    $this->writeForwardDraft($page, $author, 'Draft body.');

    $this->space->set('managers', []);
    $this->space->save();
    // The commit above rendered the draft back to its author, which memoized
    // view-allowed in the handler's per-process cache; separate requests do
    // not share it, the kernel harness does.
    $this->container->get('entity_type.manager')->getAccessControlHandler('node')->resetCache();

    $response = $this->readWorkingCopy($page, $author);
    $this->assertSame(403, $response->getStatusCode(), (string) $response->getContent());
  }

  /**
   * A working-copy read leaves the published revision alone in the next read.
   *
   * JSON:API caches a normalization under the resource type, the entity UUID
   * and the langcode; its revision reads stay apart from the default revision
   * only through the `url.query_args:resourceVersion` cache context
   * ResourceVersionRouteEnhancer adds on JSON:API routes. This pair pins that
   * separation from both directions — served from one slot, whichever of the
   * two is read first would come back as the other.
   */
  public function testPublishedReadAfterWorkingCopyReadStaysPublished(): void {
    $editor = $this->createEditor();
    $page = $this->createPublishedPage($editor->id());
    $this->seedForwardDraft($page, 'Draft body.');

    $this->assertStringContainsString('Draft body.', $this->workingCopyBody($page, $editor));
    $this->assertStringContainsString('Published body.', $this->publishedBody($page, $editor));
  }

  /**
   * And the other way round: the published read must not serve the editor.
   *
   * Split from the sequence above because a cache slot is filled by whichever
   * read comes first, so the two orders are two failures — this one would
   * hydrate the editor from the published revision, which its next checkpoint
   * then commits over the draft.
   */
  public function testWorkingCopyReadAfterPublishedReadStaysTheDraft(): void {
    $editor = $this->createEditor();
    $page = $this->createPublishedPage($editor->id());
    $this->seedForwardDraft($page, 'Draft body.');

    $this->assertStringContainsString('Published body.', $this->publishedBody($page, $editor));
    $this->assertStringContainsString('Draft body.', $this->workingCopyBody($page, $editor));
  }

  /**
   * The body the working-copy read serves.
   */
  private function workingCopyBody(NodeInterface $page, AccountInterface $user): string {
    $response = $this->readWorkingCopy($page, $user);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $document = Json::decode((string) $response->getContent());
    return (string) $document['data']['attributes']['field_kb_body']['value'];
  }

  /**
   * The body a plain JSON:API read serves — the published default revision.
   */
  private function publishedBody(NodeInterface $page, AccountInterface $user): string {
    $response = $this->request(
      '/jsonapi/node/kb_page/' . $page->uuid(),
      $user,
      'GET',
      NULL,
      ['Accept' => 'application/vnd.api+json'],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $document = Json::decode((string) $response->getContent());
    return (string) $document['data']['attributes']['field_kb_body']['value'];
  }

  /**
   * Puts a forward draft on the page by saving one, not by committing one.
   *
   * The access tests go through the commit route because a checkpoint is what
   * writes drafts in production; here the subject is the read's cache
   * boundary, and the write's own response would be one more thing between
   * the two reads whose collision is the subject.
   */
  private function seedForwardDraft(NodeInterface $page, string $body): void {
    $page->setNewRevision(TRUE);
    $page->set('moderation_state', 'draft');
    $page->set('field_kb_body', ['value' => $body, 'format' => 'comark']);
    $page->save();
  }

  /**
   * An account on the space's manager roster — update access inside a space.
   */
  private function createEditor(): AccountInterface {
    $account = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $this->space->get('managers')->appendItem(['target_id' => $account->id()]);
    $this->space->save();
    return $account;
  }

  /**
   * Builds a Published page in the space, owned by the given user.
   */
  private function createPublishedPage(string|int $uid): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Shared page',
      'uid' => $uid,
      'moderation_state' => 'published',
      'field_space' => ['target_id' => $this->space->id()],
      'field_kb_body' => ['value' => 'Published body.', 'format' => 'comark'],
    ]);
    $page->save();
    return $page;
  }

  /**
   * Leaves a forward draft on the page, the way a checkpoint does.
   */
  private function writeForwardDraft(NodeInterface $page, AccountInterface $user, string $body): void {
    $response = $this->request(
      '/openkb/node/' . $page->id() . '/commit',
      $user,
      'POST',
      ['attributes' => ['field_kb_body' => ['value' => $body, 'format' => 'comark']]],
      // Generator and validator share the session_manager.metadata_bag service
      // in-process, so this token is the one the route accepts.
      ['X-CSRF-Token' => $this->container->get('csrf_token')->get('rest')],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
  }

  /**
   * Reads the working copy over JSON:API, as the given user.
   */
  private function readWorkingCopy(NodeInterface $page, AccountInterface $user): Response {
    return $this->request(
      '/jsonapi/node/kb_page/' . $page->uuid() . '?resourceVersion=rel%3Aworking-copy',
      $user,
      'GET',
      NULL,
      ['Accept' => 'application/vnd.api+json'],
    );
  }

}
