<?php

declare(strict_types=1);

namespace Drupal\inline_comment;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Component\Serialization\Json;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Database\IntegrityConstraintViolationException;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Entity\TranslatableInterface;
use Drupal\inline_comment\Entity\InlineComment;
use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * The stored inline comments of an entity translation.
 *
 * The whole model is one set per translation, reconciled as a whole. A caller
 * holds the conversation live, and states it: coordinates it names that are
 * not stored are inserted, coordinates that are stored are left exactly as they
 * are, and coordinates it does not name are dropped. So the durable side is a
 * mirror of the caller's, restating is free, and a message that outlived what
 * it was about leaves without anything here knowing what that was.
 *
 * Callers are trusted about the author: `uid` is whatever they pass. A message
 * is one person's words, and the party delivering a conversation is not always
 * the one who said it — a server carrying a whole session's notes states
 * several authors in one call. Who may state anything at all is the endpoint's
 * answer.
 *
 * Order is `created`, then the row id — which is arrival order, because one
 * call stamps its whole batch with one clock.
 */
final class InlineCommentManager {

  /**
   * The entity type holding one message.
   */
  private const ENTITY_TYPE = 'inline_comment';

  /**
   * Reach any verb of the endpoint.
   */
  public const PERMISSION_USE = 'use inline comments api';

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly ConfigFactoryInterface $configFactory,
    private readonly TimeInterface $time,
    private readonly LoggerInterface $logger,
  ) {}

  /**
   * The commented entity translation a request names.
   *
   * Access is not asked here — that is the endpoint's access check, which
   * resolves the subject through this method.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request. GET and DELETE name the subject in the query, PUT in the
   *   body.
   *
   * @return \Drupal\Core\Entity\EntityInterface
   *   The entity, in the named translation.
   */
  public function subject(Request $request): EntityInterface {
    $params = $request->isMethod('PUT') ? $this->body($request) : $request->query->all();
    $entity_type = (string) ($params['entity_type'] ?? '');
    $entity_id = (string) ($params['entity_id'] ?? '');
    if (!in_array($entity_type, $this->commentableEntityTypes(), TRUE)) {
      throw new BadRequestHttpException('This site does not comment on that entity type.');
    }
    $subject = $this->entityTypeManager->getStorage($entity_type)->load($entity_id);
    if ($subject === NULL) {
      throw new NotFoundHttpException('There is no such entity.');
    }
    $langcode = (string) ($params['langcode'] ?? '');
    if ($langcode !== '' && $subject instanceof TranslatableInterface && $subject->hasTranslation($langcode)) {
      $subject = $subject->getTranslation($langcode);
    }
    return $subject;
  }

  /**
   * The decoded body of a request, or nothing when it is not a JSON object.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   *
   * @return array
   *   The decoded body.
   */
  public function body(Request $request): array {
    $payload = Json::decode((string) $request->getContent());
    return is_array($payload) ? $payload : [];
  }

  /**
   * The entity types this site comments on.
   *
   * @return string[]
   *   The entity type ids.
   */
  private function commentableEntityTypes(): array {
    $configured = $this->configFactory->get('inline_comment.settings')->get('entity_types');
    return is_array($configured) ? array_map('strval', $configured) : [];
  }

  /**
   * Makes the translation's stored messages the ones stated.
   *
   * Answers what moved. A message that does not validate is logged and
   * skipped, never thrown: a caller states its whole conversation at once, so
   * erroring on one member would hold every other message in it hostage.
   *
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity, in the translation the messages are about.
   * @param array[] $messages
   *   Each as `{anchor, thread_id, msg_id, uid, data?}`.
   *
   * @return array{stored: int, dropped: int}
   *   How many messages this call added and removed.
   */
  public function put(EntityInterface $subject, array $messages): array {
    $storage = $this->entityTypeManager->getStorage(self::ENTITY_TYPE);
    $held = $this->load($subject);
    $rows = [];
    foreach ($held as $id => $comment) {
      $rows[$this->coordinatesOf(
        (string) $comment->get('anchor')->value,
        (string) $comment->get('thread_id')->value,
        (string) $comment->get('msg_id')->value,
      )] = $id;
    }

    $stored = 0;
    $kept = [];
    foreach ($messages as $message) {
      $coordinates = $this->coordinatesOf($message['anchor'], $message['thread_id'], $message['msg_id']);
      if (isset($rows[$coordinates])) {
        $kept[$rows[$coordinates]] = TRUE;
        continue;
      }
      $comment = $storage->create([
        'entity_type' => $subject->getEntityTypeId(),
        'entity_id' => (string) $subject->id(),
        'langcode' => $subject->language()->getId(),
        'anchor' => $message['anchor'],
        'thread_id' => $message['thread_id'],
        'msg_id' => $message['msg_id'],
        'uid' => $message['uid'],
        'created' => $this->time->getRequestTime(),
        'data' => $message['data'] ?? [],
      ]);
      if ($this->insert($comment, $subject)) {
        $stored++;
      }
    }

    $gone = array_diff_key($held, $kept);
    if ($gone !== []) {
      $storage->delete($gone);
    }
    return ['stored' => $stored, 'dropped' => count($gone)];
  }

  /**
   * Every message about one translation, oldest first.
   *
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity.
   *
   * @return array[]
   *   Each as `{anchor, thread_id, msg_id, uid, data}`.
   */
  public function messages(EntityInterface $subject): array {
    $messages = [];
    foreach ($this->load($subject) as $comment) {
      $messages[] = [
        'anchor' => (string) $comment->get('anchor')->value,
        'thread_id' => (string) $comment->get('thread_id')->value,
        'msg_id' => (string) $comment->get('msg_id')->value,
        'uid' => (int) $comment->get('uid')->target_id,
        'data' => $comment->data(),
      ];
    }
    return $messages;
  }

  /**
   * Drops every message about one translation.
   *
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity, in the translation to clear.
   *
   * @return int
   *   How many messages were dropped.
   */
  public function deleteTranslation(EntityInterface $subject): int {
    $held = $this->load($subject);
    if ($held !== []) {
      $this->entityTypeManager->getStorage(self::ENTITY_TYPE)->delete($held);
    }
    return count($held);
  }

  /**
   * Drops every message about an entity, in every translation.
   *
   * Nothing references these rows the other way round, so the entity leaving
   * is the only thing that can take them.
   *
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The entity being deleted.
   */
  public function deleteFor(EntityInterface $subject): void {
    $storage = $this->entityTypeManager->getStorage(self::ENTITY_TYPE);
    $ids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('entity_type', $subject->getEntityTypeId())
      ->condition('entity_id', (string) $subject->id())
      ->execute();
    if ($ids !== []) {
      $storage->delete($storage->loadMultiple($ids));
    }
  }

  /**
   * Stores one message, or says why it could not be.
   *
   * @param \Drupal\inline_comment\Entity\InlineComment $comment
   *   The message.
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity, for the log line.
   *
   * @return bool
   *   TRUE when the message is now stored.
   */
  private function insert(InlineComment $comment, EntityInterface $subject): bool {
    $violations = $comment->validate();
    if (count($violations) > 0) {
      $this->logger->warning('Refused an inline comment on @entity: @why.', [
        '@entity' => $subject->getEntityTypeId() . ' ' . $subject->id(),
        '@why' => implode(' ', array_map(
          static fn ($violation) => (string) $violation->getMessage(),
          iterator_to_array($violations),
        )),
      ]);
      return FALSE;
    }
    try {
      $comment->save();
      return TRUE;
    }
    catch (IntegrityConstraintViolationException) {
      // Two callers stating one conversation at once: both read before either
      // wrote, so the unique key is what actually decides. The loser's message
      // is already stored, by the winner.
      return FALSE;
    }
  }

  /**
   * The lookup key naming one message within a translation.
   *
   * @param string $anchor
   *   The anchor.
   * @param string $thread_id
   *   The thread.
   * @param string $msg_id
   *   The message.
   *
   * @return string
   *   The key.
   */
  private function coordinatesOf(string $anchor, string $thread_id, string $msg_id): string {
    return implode("\0", [$anchor, $thread_id, $msg_id]);
  }

  /**
   * One translation's messages as entities, in the order they were said.
   *
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity.
   *
   * @return \Drupal\inline_comment\Entity\InlineComment[]
   *   The messages, keyed by their entity id.
   */
  private function load(EntityInterface $subject): array {
    if ($subject->isNew()) {
      return [];
    }
    $storage = $this->entityTypeManager->getStorage(self::ENTITY_TYPE);
    $ids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('entity_type', $subject->getEntityTypeId())
      ->condition('entity_id', (string) $subject->id())
      ->condition('langcode', $subject->language()->getId())
      ->sort('created')
      ->sort('id')
      ->execute();
    if ($ids === []) {
      return [];
    }
    // loadMultiple answers in storage order, so the sort is re-applied by
    // walking the ids the query returned.
    $loaded = $storage->loadMultiple($ids);
    $ordered = [];
    foreach ($ids as $id) {
      if (isset($loaded[$id])) {
        $ordered[$id] = $loaded[$id];
      }
    }
    return $ordered;
  }

}
