<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_revision\Kernel;

use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;

/**
 * The revision history this app serves itself.
 *
 * `GET /node/{node}/revisions` in custom-elements format — the path Drupal's
 * own overview answers on, so the *Revisions* local task shipped with every CE
 * page response is a link the frontend can follow.
 *
 * Two things are under test and the second has the teeth: that the list says
 * what a history has to say, and who may read it. Core answers `view all
 * revisions` on the revision permission alone and this site grants that
 * permission to every signed-in user, so the space realm has to be asked
 * separately. The users here carry exactly the shipped recipe's grants, read
 * from the real recipe.yml, because that grant is why the check exists.
 *
 * A read is all this route is, so it is a kernel test: revisions are seeded
 * with ->save() and the response comes back through the http_kernel, the way
 * the frontend's CE-API proxy asks for it. The one history fact a plain save
 * cannot make — the live row of a publish that moved no stored field — is the
 * commit route's doing and stays a browser test.
 *
 * @group openkb_revision
 * @see \Drupal\Tests\openkb_revision\Functional\NodeRevisionHistoryTest
 */
final class NodeRevisionHistoryTest extends OpenkbRequestKernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'metatag',
    'token',
    'custom_elements',
    'lupus_ce_renderer',
    'openkb_revision',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->container->get('router.builder')->rebuild();
  }

  /**
   * The whole history, newest first, with both markers on the right rows.
   *
   * A published node then edited is the ordinary state of one being worked on:
   * the newest revision is a draft and the live one is older. A list ordered by
   * date alone could not tell those apart, which is why `current` and
   * `published` are separate facts.
   */
  public function testHistoryListsEveryRevisionNewestFirst(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published', 'First cut.');
    $published_vid = (int) $page->getRevisionId();
    $draft_vid = $this->addRevision($page, 'draft', 'Reworked the intro.');

    $content = $this->readHistory($page, $editor);

    $this->assertSame('node-revision-history', $content['element']);
    $this->assertSame((int) $page->id(), $content['props']['nid']);
    $this->assertSame('Space page', $content['props']['title']);
    $this->assertSame('/node/' . $page->id(), $content['props']['nodeUrl']);
    $this->assertSame(2, $content['props']['total']);

    $revisions = $content['slots']['revisions'];
    $this->assertCount(2, $revisions);

    [$newest, $oldest] = $revisions;
    $this->assertSame('node-revision', $newest['element']);
    $this->assertSame($draft_vid, $newest['props']['vid']);
    $this->assertSame('draft', $newest['props']['state']);
    $this->assertSame('Reworked the intro.', $newest['props']['log']);
    $this->assertSame($editor->getAccountName(), $newest['props']['author']);
    $this->assertTrue($newest['props']['current']);
    $this->assertFalse($newest['props']['published']);

    $this->assertSame($published_vid, $oldest['props']['vid']);
    $this->assertSame('published', $oldest['props']['state']);
    $this->assertFalse($oldest['props']['current']);
    $this->assertTrue($oldest['props']['published']);

    // A timestamp the frontend can render in the reader's own zone.
    $this->assertMatchesRegularExpression(
      '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/',
      $newest['props']['created'],
    );
  }

  /**
   * A save with no message carries no message — not an empty one.
   */
  public function testRevisionWithoutLogMessageOmitsIt(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published', '');

    $revision = $this->readHistory($page, $editor)['slots']['revisions'][0];

    $this->assertArrayNotHasKey('log', $revision['props']);
  }

  /**
   * Nothing live yet: the working copy is current and no row is published.
   */
  public function testNeverPublishedPageHasNoPublishedRevision(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'draft', 'Started.');

    $revision = $this->readHistory($page, $editor)['slots']['revisions'][0];

    $this->assertTrue($revision['props']['current']);
    $this->assertFalse($revision['props']['published']);
  }

  /**
   * Past core's page window the response still says how much history there is.
   *
   * Every editing session checkpoints into a revision, so the count is the part
   * of a long history that stays true — a list silently stopping at the window
   * would read as a node edited fifty times.
   */
  public function testLongHistoryIsWindowedButCounted(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published', 'First cut.');
    for ($i = 0; $i < 51; $i++) {
      $this->addRevision($page, 'draft', 'Checkpoint ' . $i);
    }

    $content = $this->readHistory($page, $editor);

    $this->assertSame(52, $content['props']['total']);
    $this->assertSame(50, $content['props']['shown']);
    $this->assertCount(50, $content['slots']['revisions']);
    // The fifty kept are the newest fifty.
    $this->assertSame('Checkpoint 50', $content['slots']['revisions'][0]['props']['log']);
  }

  /**
   * A revision that moved only the state is still a row.
   *
   * The list comes from core's revision loader, which lists translation-
   * affecting revisions — so this pins that a pull-back qualifies even though
   * it edits no field the author typed. It is the event a reader comes to a
   * history for.
   */
  public function testStateOnlyRevisionIsListed(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published', 'First cut.');

    $page->setNewRevision(TRUE);
    $page->set('moderation_state', 'draft');
    $page->setRevisionUserId((int) $editor->id());
    $page->setRevisionLogMessage('Pulled it back to draft.');
    $page->save();

    $content = $this->readHistory($page, $editor);

    $this->assertSame(2, $content['props']['total']);
    $this->assertCount(2, $content['slots']['revisions']);
    $this->assertSame('Pulled it back to draft.', $content['slots']['revisions'][0]['props']['log']);
  }

  /**
   * The route requires `view all revisions` — and grants on it.
   *
   * Read access to the node is not enough on its own, and read access plus this
   * one permission is: the requirement core ships
   * (`_entity_access: node.view all revisions`) is doing the work, so the
   * history is never a way around the permission guarding Drupal's own
   * overview.
   */
  public function testViewAllRevisionsPermissionIsRequired(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published', 'First cut.');

    $reader = $this->createUser(['access content']);
    $this->assertSame(403, $this->requestHistory($page, $reader)->getStatusCode());

    $revision_reader = $this->createUser(['access content', 'view all revisions']);
    $this->assertSame(200, $this->requestHistory($page, $revision_reader)->getStatusCode());
  }

  /**
   * A private space's history is the space's, not every signed-in user's.
   *
   * The outsider holds `view kb_page revisions` — the recipe grants it to
   * the authenticated role — and core would answer on that permission alone.
   * What denies them is read access to the node itself, which inside a space is
   * the space's roster.
   *
   * 404 rather than 403 for the reason every other path into a private space
   * answers 404 (HideInvisibleSpaceSubscriber): a forbidden confirms the
   * page is there. Getting that for free is the payoff of denying on plain
   * `view` access instead of a check of this route's own.
   */
  public function testPrivateSpaceHistoryStaysInside(): void {
    $editor = $this->createEditor();
    $space = $this->createPrivateSpace($editor);
    $page = $this->createPage($editor->id(), 'published', 'First cut.', $space);

    $outsider = $this->createEditor();
    $this->assertContains('view kb_page revisions', $this->recipeGrantedPermissions('authenticated'));
    $this->assertSame(404, $this->requestHistory($page, $outsider)->getStatusCode());

    // And the roster reads it, so the denial is the space's, not the route's.
    $this->assertSame(200, $this->requestHistory($page, $editor)->getStatusCode());
  }

  /**
   * A user carrying exactly the recipe's authenticated grants.
   */
  private function createEditor(): AccountInterface {
    return $this->createUser($this->recipeGrantedPermissions('authenticated'));
  }

  /**
   * A space only its roster may read.
   */
  private function createPrivateSpace(AccountInterface $editor): SpaceInterface {
    $space = Space::create([
      'label' => 'Handbook',
      'read_access' => 'members_only',
      'field_moderation' => 1,
      'managers' => [['target_id' => $editor->id()]],
    ]);
    $space->save();
    return $space;
  }

  /**
   * Builds a page, seeded past validation.
   *
   * Direct ->save() skips entity validation, so seeding needs no transition
   * permission — the permissions under test are the reader's.
   */
  private function createPage(string|int $uid, string $state, string $log, ?SpaceInterface $space = NULL): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Space page',
      'uid' => $uid,
      'moderation_state' => $state,
      'field_kb_body' => ['value' => 'Body.', 'format' => 'comark'],
      'revision_uid' => $uid,
      'revision_log' => $log,
    ] + ($space ? ['field_space' => ['target_id' => $space->id()]] : []));
    $page->save();
    return $page;
  }

  /**
   * Adds a revision on top, and returns its id.
   *
   * The body carries the log message so every revision is a real change, the
   * way a checkpoint of an editing session is: core's revision loader lists the
   * revisions that affect the translation, so a save that changed nothing at
   * all is not a row — on this page or on Drupal's own.
   */
  private function addRevision(NodeInterface $page, string $state, string $log): int {
    $page->setNewRevision(TRUE);
    $page->set('moderation_state', $state);
    $page->set('field_kb_body', ['value' => 'Body. ' . $log, 'format' => 'comark']);
    $page->setRevisionUserId($page->getOwnerId());
    $page->setRevisionLogMessage($log);
    $page->save();
    return (int) $page->getRevisionId();
  }

  /**
   * Reads the history as the given user, asserting it was served.
   *
   * @return array
   *   The `content` half of the CE response.
   */
  private function readHistory(NodeInterface $page, AccountInterface $user): array {
    $response = $this->requestHistory($page, $user);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    return $this->decode($response)['content'];
  }

  /**
   * Requests the history the way the frontend's CE-API proxy does.
   */
  private function requestHistory(NodeInterface $page, AccountInterface $user) {
    return $this->request(
      '/node/' . $page->id() . '/revisions?_format=custom_elements&_content_format=json',
      $user,
    );
  }

}
