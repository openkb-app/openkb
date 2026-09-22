<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_media_library\Kernel;

use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AnonymousUserSession;
use Drupal\KernelTests\KernelTestBase;
use Drupal\media_library\MediaLibraryState;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\openkb_media_library\Controller\EditorAssetsController;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Symfony\Component\HttpFoundation\Request;

/**
 * Tests the editor opener's delegated entity-access check.
 *
 * The picker carries no permission of its own: the opener grants the dialog
 * by update access on the target page (nid in the opener parameters), so
 * every current and future node-access rule applies automatically. The
 * matrix below proves the delegation is real — the same account passes on
 * its own page and fails on someone else's.
 *
 * @group openkb_media_library
 */
final class MediaLibraryEditorAccessTest extends KernelTestBase {

  use UserCreationTrait;

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
    'file',
    'image',
    'media',
    'views',
    'media_library',
    'openkb_media_library',
  ];

  /**
   * Page owned by the editor account.
   */
  private Node $ownPage;

  /**
   * Page owned by somebody else.
   */
  private Node $foreignPage;

  /**
   * Account holding only `edit own kb_page content`.
   */
  private AccountInterface $editor;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();

    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['user', 'filter', 'node']);

    NodeType::create(['type' => 'kb_page', 'name' => 'Page'])->save();

    // Burn uid 1 — it bypasses all access checks.
    $this->createUser([], 'root');

    $other = $this->createUser(['access content', 'edit own kb_page content']);
    $this->editor = $this->createUser(['access content', 'edit own kb_page content']);

    $this->foreignPage = Node::create([
      'type' => 'kb_page',
      'title' => 'Someone else\'s page',
      'uid' => $other->id(),
    ]);
    $this->foreignPage->save();

    $this->ownPage = Node::create([
      'type' => 'kb_page',
      'title' => 'Own page',
      'uid' => $this->editor->id(),
    ]);
    $this->ownPage->save();
  }

  /**
   * Builds the state the assets endpoint mints for a target page.
   */
  private function state(?int $nid): MediaLibraryState {
    // String-typed like the real state: query parsing yields strings.
    $parameters = $nid === NULL ? [] : ['nid' => (string) $nid];
    return MediaLibraryState::create('openkb_media_library.opener', ['image'], 'image', -1, $parameters);
  }

  /**
   * Tests the opener's checkAccess() delegation matrix.
   */
  public function testOpenerDelegatesToNodeUpdateAccess(): void {
    $opener = $this->container->get('openkb_media_library.opener');

    // Anonymous holds no update access anywhere — forbidden.
    $anonymous = new AnonymousUserSession();
    $this->assertFalse($opener->checkAccess($this->state((int) $this->ownPage->id()), $anonymous)->isAllowed());

    // The editor may pick media for their own page.
    $this->assertTrue($opener->checkAccess($this->state((int) $this->ownPage->id()), $this->editor)->isAllowed());

    // But not for someone else's: same account, other page, forbidden.
    // This is the case that proves delegation — a permission-based gate
    // could not tell these two states apart.
    $this->assertFalse($opener->checkAccess($this->state((int) $this->foreignPage->id()), $this->editor)->isAllowed());

    // `edit any` passes on both.
    $admin = $this->createUser(['access content', 'edit any kb_page content']);
    $this->assertTrue($opener->checkAccess($this->state((int) $this->foreignPage->id()), $admin)->isAllowed());

    // Degenerate states: missing or dangling nid — forbidden.
    $this->assertFalse($opener->checkAccess($this->state(NULL), $this->editor)->isAllowed());
    $this->assertFalse($opener->checkAccess($this->state(999), $this->editor)->isAllowed());
  }

  /**
   * Tests that the assets endpoint gates on the same opener check.
   */
  public function testAssetsEndpointRunsOpenerCheck(): void {
    $controller = EditorAssetsController::create($this->container);
    $request = static fn (?string $nid): Request => Request::create('/openkb/media-library/assets', 'GET', $nid === NULL ? [] : ['nid' => $nid]);

    $this->assertFalse($controller->access(new AnonymousUserSession(), $request((string) $this->ownPage->id()))->isAllowed());
    $this->assertTrue($controller->access($this->editor, $request((string) $this->ownPage->id()))->isAllowed());
    $this->assertFalse($controller->access($this->editor, $request((string) $this->foreignPage->id()))->isAllowed());
    // No or non-numeric nid never reaches the opener — forbidden outright.
    $this->assertFalse($controller->access($this->editor, $request(NULL))->isAllowed());
    $this->assertFalse($controller->access($this->editor, $request('not-a-nid'))->isAllowed());
  }

}
