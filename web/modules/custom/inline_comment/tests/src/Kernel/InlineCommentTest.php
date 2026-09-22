<?php

declare(strict_types=1);

namespace Drupal\Tests\inline_comment\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityStorageInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AnonymousUserSession;
use Drupal\KernelTests\KernelTestBase;
use Drupal\entity_test\Entity\EntityTestMul;
use Drupal\inline_comment\InlineCommentManager;
use Drupal\language\Entity\ConfigurableLanguage;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\Session\Session;
use Symfony\Component\HttpFoundation\Session\Storage\MockArraySessionStorage;

/**
 * The inline-comment model, on an entity type that knows nothing about it.
 *
 * What is pinned here is what the model promises any consumer:
 *
 * - a PUT makes the stored set the stated one — added, kept and dropped in one
 *   call — so restating it changes nothing;
 * - every verb answers the commented entity's own `update` access and the
 *   `use inline comments api` permission, and nothing else;
 * - only the entity types the site configures may be commented on;
 * - a message names its own author, and one naming nobody or naming somebody
 *   who is not an account is not stored;
 * - `data` comes back exactly as it went in;
 * - a message belongs to one entity translation, and dies with the entity;
 * - no generic surface serves a message.
 *
 * The subject is a plain `entity_test_mul` and an anchor is any string, so
 * nothing here leans on what a consumer means by one.
 *
 * @group inline_comment
 */
final class InlineCommentTest extends KernelTestBase {

  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'language',
    'entity_test',
    'inline_comment',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('entity_test_mul');
    $this->installEntitySchema('inline_comment');
    $this->installConfig(['system', 'user', 'inline_comment']);
    ConfigurableLanguage::createFromLangcode('de')->save();
    $this->container->get('router.builder')->rebuild();
    // The subject of this suite is a test entity type, so the site has to say
    // it comments on it — which is the allow-list under test below.
    $this->config('inline_comment.settings')
      ->set('entity_types', ['entity_test_mul'])
      ->save();

    // User 1 is a superuser and would answer every access question with yes.
    $this->createUser();
  }

  /**
   * One PUT adds, keeps and drops, and stating the same set again is a no-op.
   *
   * The whole model in one case: the stored set is a mirror of the caller's,
   * a message that survives is untouched, and one that is no longer stated is
   * gone. `data` rides through unread.
   */
  public function testPutMakesTheStoredSetTheStatedOne(): void {
    $editor = $this->createEditor();
    $uid = (int) $editor->id();
    $subject = $this->createSubject();
    $said = ['text' => 'is this still true?', 'resolved' => FALSE, 'range' => ['from' => 0, 'to' => 4]];

    $this->assertSame(
      ['stored' => 2, 'dropped' => 0],
      $this->put($subject, $editor, [
        $this->message('b-one', 'c-1', 'm-1', $said, $uid),
        $this->message('b-two', 'c-2', 'm-2', ['text' => 'and this one'], $uid),
      ]),
    );
    $this->assertSame(
      ['stored' => 0, 'dropped' => 0],
      $this->put($subject, $editor, [
        $this->message('b-one', 'c-1', 'm-1', $said, $uid),
        $this->message('b-two', 'c-2', 'm-2', ['text' => 'and this one'], $uid),
      ]),
      'Restating the same set adds nothing and drops nothing.',
    );

    $ids = array_keys($this->storage()->getQuery()->accessCheck(FALSE)->execute());
    $this->assertSame(
      ['stored' => 1, 'dropped' => 1],
      $this->put($subject, $editor, [
        $this->message('b-one', 'c-1', 'm-1', $said, $uid),
        $this->message('b-one', 'c-1', 'm-3', ['text' => 'a reply'], $uid),
      ]),
    );

    $messages = $this->comments()->messages($subject);
    $this->assertSame(['m-1', 'm-3'], array_column($messages, 'msg_id'));
    $this->assertSame($said, $messages[0]['data'], 'What a message carries is stored and served unread.');
    $this->assertSame(
      $ids[0],
      array_keys($this->storage()->getQuery()->accessCheck(FALSE)->execute())[0],
      'A message that stays stated is the same row, not a rewrite.',
    );
  }

  /**
   * Update access on the subject AND the API permission, on every verb.
   *
   * Two answers because they say different things: update access is which
   * entities an account may talk about, and the permission is whether this
   * surface is open to it at all — the kill switch, which holds even for an
   * account that may edit everything.
   */
  public function testEveryVerbAnswersUpdateAccessAndTheApiPermission(): void {
    $editor = $this->createEditor();
    $subject = $this->createSubject();

    foreach (['GET', 'PUT', 'DELETE'] as $method) {
      $this->assertSame(
        200,
        $this->call($method, $subject, $editor)->getStatusCode(),
        $method . ' answers an account that may edit the subject.',
      );
      $this->assertSame(
        403,
        $this->call($method, $subject, $this->createUser(['use inline comments api']))->getStatusCode(),
        $method . ' refuses an account that may not edit the subject.',
      );
      $this->assertSame(
        403,
        $this->call($method, $subject, $this->createUser(['administer entity_test content']))->getStatusCode(),
        $method . ' refuses an account without the API permission, whatever it may edit.',
      );
      $this->assertSame(
        403,
        $this->call($method, $subject)->getStatusCode(),
        $method . ' refuses anonymous.',
      );
    }
    $this->assertSame(
      404,
      $this->request('/api/inline-comments?entity_type=entity_test_mul&entity_id=404', $editor)->getStatusCode(),
      'An entity that is not there is not there, whoever asks.',
    );
  }

  /**
   * A request about an entity type this site does not comment on is refused.
   *
   * The endpoint is generic and a deployment is not: which types carry
   * conversations is one config value, and naming another one is a bad
   * request rather than an access answer — there is nothing to have access to.
   */
  public function testOnlyConfiguredEntityTypesAreCommentedOn(): void {
    $editor = $this->createEditor();
    $this->config('inline_comment.settings')->set('entity_types', ['user'])->save();

    $this->assertSame(
      400,
      $this->call('GET', $this->createSubject(), $editor)->getStatusCode(),
    );
  }

  /**
   * Each message names its own author, and it has to be a real account.
   *
   * One call carries several people's words — a conversation is delivered by
   * whoever witnessed it, not by whoever said any given line — so the caller
   * is taken at its word about the author. What is not taken on trust is that
   * the author exists.
   */
  public function testEachMessageNamesItsOwnAuthor(): void {
    $editor = $this->createEditor();
    $author = $this->createEditor();
    $subject = $this->createSubject();
    $said = ['text' => 'somebody else said this'];

    $this->put($subject, $editor, [
      $this->message('b-one', 'c-1', 'm-1', $said, (int) $author->id()),
      $this->message('b-one', 'c-2', 'm-2', $said, (int) $editor->id()),
    ]);
    $this->assertSame(
      [(int) $author->id(), (int) $editor->id()],
      array_column($this->comments()->messages($subject), 'uid'),
      'The stated author is the author, whoever sent the call.',
    );
  }

  /**
   * An unstorable message does not hold the rest of the conversation hostage.
   *
   * A caller states its whole conversation at once, so a member that can never
   * be stored — an id that is not one, an author who is not an account — must
   * not keep every other message out of storage with it.
   */
  public function testAnUnstorableMessageIsSkipped(): void {
    $editor = $this->createEditor();
    $uid = (int) $editor->id();
    $subject = $this->createSubject();

    $this->put($subject, $editor, [
      $this->message('b one', 'c-1', 'm-1', ['text' => 'an anchor that is not an id'], $uid),
      $this->message('b-one', 'c-2', 'm-2', ['text' => 'nobody said this'], 987654),
      $this->message('b-one', 'c-3', 'm-3', ['text' => 'this one names nobody at all'], 0),
      $this->message('b-one', 'c-4', 'm-4', ['text' => 'and this one lands'], $uid),
    ]);

    $this->assertSame(['m-4'], array_column($this->comments()->messages($subject), 'msg_id'));
  }

  /**
   * DELETE drops the translation's messages; deleting the entity drops all.
   */
  public function testMessagesAreDroppedOnRequestAndWithTheSubject(): void {
    $editor = $this->createEditor();
    $subject = $this->createSubject();
    $this->put($subject, $editor, [$this->message('b-one', 'c-1', 'm-1', ['text' => 'said'], (int) $editor->id())]);

    $this->assertSame(1, $this->decode($this->call('DELETE', $subject, $editor))['dropped']);
    $this->assertSame([], $this->comments()->messages($subject));

    $this->put($subject, $editor, [$this->message('b-one', 'c-1', 'm-1', ['text' => 'said again'], (int) $editor->id())]);
    $subject->delete();
    $this->assertSame([], $this->storage()->getQuery()->accessCheck(FALSE)->execute());
  }

  /**
   * A message is about one translation, not about the entity.
   */
  public function testMessagesAreScopedToTheirTranslation(): void {
    $editor = $this->createEditor();
    $subject = $this->createSubject();
    $subject->addTranslation('de', ['name' => $subject->label()])->save();
    $german = $this->storage('entity_test_mul')->load($subject->id())->getTranslation('de');

    $uid = (int) $editor->id();
    $this->put($subject, $editor, [$this->message('b-one', 'c-1', 'm-1', ['text' => 'about the English text'], $uid)]);
    $this->put($german, $editor, [$this->message('b-one', 'c-1', 'm-1', ['text' => 'über den deutschen Text'], $uid)]);

    $this->assertSame(
      ['about the English text'],
      array_column(array_column($this->comments()->messages($subject), 'data'), 'text'),
    );
    $this->assertSame(
      ['über den deutschen Text'],
      array_column(array_column($this->comments()->messages($german), 'data'), 'text'),
    );
    $this->assertCount(
      2,
      $this->storage()->getQuery()->accessCheck(FALSE)->execute(),
      'The coordinates only collide within one translation.',
    );
  }

  /**
   * No generic surface serves a message, and none is closed by a permission.
   *
   * The entity type is `internal` and names no admin permission and no access
   * handler: JSON:API builds no route for it at all, and the default access
   * handler answers every account with no. So there is no permission to grant
   * by accident — the module's endpoint is the whole of what serves a message.
   */
  public function testNoGenericSurfaceServesMessages(): void {
    $editor = $this->createEditor();
    $subject = $this->createSubject();
    $this->put($subject, $editor, [$this->message('b-one', 'c-1', 'm-1', ['text' => 'is this still true?'], (int) $editor->id())]);

    $definition = $this->container->get('entity_type.manager')->getDefinition('inline_comment');
    $this->assertTrue($definition->isInternal());
    $this->assertFalse($definition->getAdminPermission(), 'No permission opens it, so none can be granted by accident.');

    $comment = $this->storage()->loadMultiple()[1];
    $accounts = [$editor, $this->createUser(), $this->createUser(['administer entity_test content'])];
    foreach ($accounts as $account) {
      foreach (['view', 'update', 'delete'] as $operation) {
        $this->assertFalse(
          $comment->access($operation, $account),
          sprintf('%s is refused to every account.', $operation),
        );
      }
    }
  }

  /**
   * The single message stored on one anchor.
   *
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity.
   * @param string $anchor
   *   The anchor.
   *
   * @return array
   *   The message.
   */
  private function messageAt(EntityInterface $subject, string $anchor): array {
    $found = array_values(array_filter(
      $this->comments()->messages($subject),
      static fn (array $message) => $message['anchor'] === $anchor,
    ));
    $this->assertCount(1, $found);
    return $found[0];
  }

  /**
   * One message, as a PUT states it.
   *
   * @param string $anchor
   *   The region it is about.
   * @param string $thread
   *   The thread.
   * @param string $message
   *   The message id.
   * @param array $data
   *   What it carries.
   * @param int $uid
   *   The author it names.
   *
   * @return array
   *   The stated message.
   */
  private function message(string $anchor, string $thread, string $message, array $data, int $uid): array {
    return [
      'anchor' => $anchor,
      'thread_id' => $thread,
      'msg_id' => $message,
      'uid' => $uid,
      'data' => $data,
    ];
  }

  /**
   * PUTs a set of messages about a subject, and answers what moved.
   *
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity, in the translation the messages are about.
   * @param \Drupal\Core\Session\AccountInterface $account
   *   The account the request authenticates as.
   * @param array[] $messages
   *   The stated messages.
   *
   * @return array
   *   The `stored` and `dropped` counts.
   */
  private function put(EntityInterface $subject, AccountInterface $account, array $messages): array {
    $response = $this->call('PUT', $subject, $account, $messages);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    return array_intersect_key($this->decode($response), ['stored' => 0, 'dropped' => 0]);
  }

  /**
   * One request against the endpoint, about one subject.
   *
   * @param string $method
   *   The HTTP method.
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity.
   * @param \Drupal\Core\Session\AccountInterface|null $account
   *   The account to authenticate as, or NULL to stay anonymous.
   * @param array[] $messages
   *   The stated messages, for a PUT.
   *
   * @return \Symfony\Component\HttpFoundation\Response
   *   The response.
   */
  private function call(
    string $method,
    EntityInterface $subject,
    ?AccountInterface $account = NULL,
    array $messages = [],
  ): Response {
    $names = [
      'entity_type' => $subject->getEntityTypeId(),
      'entity_id' => (string) $subject->id(),
      'langcode' => $subject->language()->getId(),
    ];
    return $method === 'PUT'
      ? $this->request('/api/inline-comments', $account, 'PUT', $names + ['messages' => $messages])
      : $this->request('/api/inline-comments?' . http_build_query($names), $account, $method);
  }

  /**
   * Handles one request through the HTTP kernel.
   *
   * @param string $path
   *   The path.
   * @param \Drupal\Core\Session\AccountInterface|null $account
   *   The account to authenticate as, or NULL to stay anonymous.
   * @param string $method
   *   The HTTP method.
   * @param array|null $payload
   *   A JSON body, or NULL for none.
   *
   * @return \Symfony\Component\HttpFoundation\Response
   *   The response.
   */
  private function request(
    string $path,
    ?AccountInterface $account = NULL,
    string $method = 'GET',
    ?array $payload = NULL,
  ): Response {
    $request = Request::create($path, $method, [], [], [], [], $payload === NULL ? NULL : Json::encode($payload));
    if ($payload !== NULL) {
      $request->headers->set('Content-Type', 'application/json');
    }
    if ($method !== 'GET') {
      $request->headers->set('X-CSRF-Token', $this->container->get('csrf_token')->get('rest'));
    }
    if ($account !== NULL) {
      // The session cookie is the only credential a route naming no
      // authentication provider answers to.
      $session = new Session(new MockArraySessionStorage());
      $session->set('uid', (int) $account->id());
      $request->setSession($session);
      $name = $this->container->get('session_configuration')->getOptions($request)['name'];
      $request->cookies->set($name, $session->getId());
    }

    $response = $this->container->get('http_kernel')->handle($request);
    // The kernel leaves the account it authenticated as the current user. Put
    // it back, so an assertion reading storage afterwards is not silently
    // making its own access decisions as the caller under test.
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
    // Rendering a 4xx page hands the inner router a request context of its
    // own, fixed to GET
    // ({@see \Drupal\Core\EventSubscriber\DefaultExceptionHtmlSubscriber::makeSubrequest}).
    // One request per process never notices; here the next PUT would be
    // answered 405 by a router still reading GET.
    $this->container->get('router.no_access_checks')
      ->setContext($this->container->get('router.request_context'));
    return $response;
  }

  /**
   * The decoded body of a response.
   *
   * @param \Symfony\Component\HttpFoundation\Response $response
   *   The response.
   *
   * @return array
   *   The decoded document.
   */
  private function decode(Response $response): array {
    $decoded = Json::decode((string) $response->getContent());
    return is_array($decoded) ? $decoded : [];
  }

  /**
   * An account that may edit what it comments on, and reach the endpoint.
   *
   * @return \Drupal\Core\Session\AccountInterface
   *   The account.
   */
  private function createEditor(): AccountInterface {
    return $this->createUser(['administer entity_test content', 'use inline comments api']);
  }

  /**
   * A subject to comment on.
   */
  private function createSubject(): EntityTestMul {
    $subject = EntityTestMul::create(['name' => 'subject', 'langcode' => 'en']);
    $subject->save();
    return $subject;
  }

  /**
   * The model.
   */
  private function comments(): InlineCommentManager {
    return $this->container->get('inline_comment.manager');
  }

  /**
   * An entity storage handler.
   *
   * @param string $entity_type
   *   The entity type id.
   *
   * @return \Drupal\Core\Entity\EntityStorageInterface
   *   The storage.
   */
  private function storage(string $entity_type = 'inline_comment'): EntityStorageInterface {
    return $this->container->get('entity_type.manager')->getStorage($entity_type);
  }

}
