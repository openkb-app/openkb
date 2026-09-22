<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_collab_api\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Database\DatabaseExceptionWrapper;
use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\openkb_collab_api\StaleCommitException;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\HttpKernelInterface;

/**
 * Drupal refuses a commit assembled against a revision it has moved past.
 *
 * The payload may name `based_on_changed`, the working copy's `changed` it was
 * built on. The sidecar lock orders concurrent writers but cannot tell a stale
 * one from a current one, so without this check the lost-update path is: a
 * session reads at T0, somebody else writes at T1, the session commits T0's
 * text plus its own edits, and T1's content is gone.
 *
 * The token is judged on the token, not on the caller — every write reaching
 * CommitResource::write() is covered, the checkpoint a sign-off rides on
 * included. A payload naming no token is not checked: the moderation actions
 * commit a judgement about whatever the working copy is now and read no
 * content to overwrite.
 *
 * @group openkb_collab_api
 */
final class StaleCommitTest extends OpenkbRequestKernelTestBase {

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

    $this->config('jsonapi.settings')->set('read_only', FALSE)->save();
    $this->container->get('router.builder')->rebuild();
  }

  /**
   * A commit naming an older revision is refused, and writes nothing.
   */
  public function testStaleTokenIsRefused(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createDraftPage($editor->id());
    $stale = (int) $page->getChangedTime() - 60;
    $vid_before = $this->workingCopy($page)->getRevisionId();

    $response = $this->postCommit($page, $editor, [
      'attributes' => ['field_kb_body' => ['value' => 'Clobbering body.', 'format' => 'comark']],
      'based_on_changed' => $stale,
    ]);

    $this->assertSame(409, $response->getStatusCode(), (string) $response->getContent());
    $error = Json::decode((string) $response->getContent())['errors'][0];
    $this->assertSame($stale, $error['meta']['expected']);
    $this->assertSame((int) $page->getChangedTime(), $error['meta']['actual']);

    $latest = $this->workingCopy($page);
    $this->assertSame($vid_before, $latest->getRevisionId());
    $this->assertSame('Draft body.', $latest->get('field_kb_body')->value);
  }

  /**
   * A commit naming the revision it was built on is written.
   */
  public function testMatchingTokenCommits(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createDraftPage($editor->id());

    $response = $this->postCommit($page, $editor, [
      'attributes' => ['field_kb_body' => ['value' => 'Next body.', 'format' => 'comark']],
      'based_on_changed' => (int) $page->getChangedTime(),
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame('Next body.', $this->workingCopy($page)->get('field_kb_body')->value);
  }

  /**
   * The token a commit writes is the one the next commit must name.
   *
   * The round trip the collaboration server makes: commit, take `changed` from
   * the response, commit again against it. A session that reads its token from
   * anywhere else is the stale case above.
   */
  public function testTokenFromOneCommitCarriesTheNext(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createDraftPage($editor->id());

    $first = $this->postCommit($page, $editor, [
      'attributes' => ['field_kb_body' => ['value' => 'First.', 'format' => 'comark']],
      'based_on_changed' => (int) $page->getChangedTime(),
    ]);
    $this->assertSame(200, $first->getStatusCode(), (string) $first->getContent());
    $written = Json::decode((string) $first->getContent())['data']['attributes']['changed'];

    $second = $this->postCommit($page, $editor, [
      'attributes' => ['field_kb_body' => ['value' => 'Second.', 'format' => 'comark']],
      'based_on_changed' => strtotime($written),
    ]);

    $this->assertSame(200, $second->getStatusCode(), (string) $second->getContent());
    $this->assertSame('Second.', $this->workingCopy($page)->get('field_kb_body')->value);
  }

  /**
   * An external write between two commits makes the session's token stale.
   *
   * The lost-update path end to end: the session's token is the revision it
   * last wrote, somebody else writes over it, and the session's next commit is
   * refused instead of carrying the external revision away.
   */
  public function testAnExternalWriteMakesTheSessionsTokenStale(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createDraftPage($editor->id());
    $session_token = (int) $page->getChangedTime();

    // Somebody else writes — Drupal admin, an agent, another session.
    $external = $this->workingCopy($page);
    $external->set('field_kb_body', ['value' => 'External body.', 'format' => 'comark']);
    $external->setNewRevision(TRUE);
    $external->setChangedTime($session_token + 60);
    $external->save();

    $response = $this->postCommit($page, $editor, [
      'attributes' => ['field_kb_body' => ['value' => 'Session body.', 'format' => 'comark']],
      'based_on_changed' => $session_token,
    ]);

    $this->assertSame(409, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame('External body.', $this->workingCopy($page)->get('field_kb_body')->value);
  }

  /**
   * A payload naming no token is written — the moderation actions' shape.
   *
   * Publish names a state and no content: a judgement about whatever the
   * working copy is now, with nothing read that a concurrent write could
   * invalidate.
   */
  public function testAbsentTokenIsNotChecked(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createDraftPage($editor->id());

    $response = $this->postCommit($page, $editor, [
      'attributes' => [
        'moderation_state' => 'published',
        'revision_log' => 'OpenKB moderation transition (published)',
      ],
    ]);

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame('published', $this->workingCopy($page)->get('moderation_state')->value);
  }

  /**
   * A token that is not a timestamp is a bad request, not a silent pass.
   */
  public function testNonNumericTokenIsRefused(): void {
    $editor = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $page = $this->createDraftPage($editor->id());

    $response = $this->postCommit($page, $editor, [
      'attributes' => ['field_kb_body' => ['value' => 'Body.', 'format' => 'comark']],
      'based_on_changed' => 'yesterday',
    ]);

    $this->assertSame(400, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame('Draft body.', $this->workingCopy($page)->get('field_kb_body')->value);
  }

  /**
   * The refusal's renderer answers for its own exception and no other.
   *
   * It is subscribed to every kernel exception at a priority ahead of
   * JSON:API's own renderer, so anything it touched by accident would reach the
   * client as a commit conflict instead of as itself — a database deadlock, an
   * access denial and a 404 alike. It leaves them for the renderer that owns
   * them: no response set, the throwable untouched.
   *
   * @dataProvider unrelatedExceptions
   */
  public function testTheRendererLeavesUnrelatedExceptionsAlone(\Throwable $exception): void {
    $event = new ExceptionEvent(
      $this->container->get('http_kernel'),
      Request::create('/anything'),
      HttpKernelInterface::MAIN_REQUEST,
      $exception,
    );

    $this->container->get('openkb_collab_api.stale_commit_subscriber')->onException($event);

    $this->assertNull($event->getResponse(), 'An unrelated exception is left unrendered.');
    $this->assertSame($exception, $event->getThrowable(), 'An unrelated exception is left unwrapped.');
  }

  /**
   * Exceptions the commit surface never answers for.
   *
   * The deadlock is the one CI actually raised: MariaDB picks a victim when two
   * writers race and tells it to retry, which is a scheduling verdict and not a
   * conflict between revisions.
   *
   * @return array<string, array{\Throwable}>
   *   Test cases.
   */
  public static function unrelatedExceptions(): array {
    return [
      'database deadlock' => [new DatabaseExceptionWrapper('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found')],
      'not found' => [new NotFoundHttpException('No such thing.')],
      'access denied' => [new AccessDeniedHttpException('Not yours.')],
      'unhandled error' => [new \RuntimeException('Something else entirely.')],
    ];
  }

  /**
   * Its own exception it does render, as the conflict document.
   */
  public function testTheRendererAnswersForItsOwnException(): void {
    $event = new ExceptionEvent(
      $this->container->get('http_kernel'),
      Request::create('/anything'),
      HttpKernelInterface::MAIN_REQUEST,
      new StaleCommitException(100, 200),
    );

    $this->container->get('openkb_collab_api.stale_commit_subscriber')->onException($event);

    $response = $event->getResponse();
    $this->assertNotNull($response);
    $this->assertSame(409, $response->getStatusCode());
    $this->assertSame(
      ['expected' => 100, 'actual' => 200],
      Json::decode((string) $response->getContent())['errors'][0]['meta'],
    );
  }

  /**
   * The node storage, read past anything this request already loaded.
   */
  private function nodeStorage(): NodeStorageInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    return $storage;
  }

  /**
   * The page's latest revision, default or not.
   */
  private function workingCopy(NodeInterface $page): NodeInterface {
    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    return $latest;
  }

  /**
   * A draft page, seeded past validation.
   */
  private function createDraftPage(string|int $uid): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Collab page',
      'uid' => $uid,
      'moderation_state' => 'draft',
      'field_kb_body' => [
        'value' => 'Draft body.',
        'format' => 'comark',
      ],
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
   * POSTs a raw commit payload as the given user, over their session and CSRF.
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

}
