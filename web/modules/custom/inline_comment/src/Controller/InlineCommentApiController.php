<?php

declare(strict_types=1);

namespace Drupal\inline_comment\Controller;

use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Entity\EntityInterface;
use Drupal\inline_comment\Entity\InlineComment;
use Drupal\inline_comment\InlineCommentManager;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * The wire surface of the stored inline comments: `/api/inline-comments`.
 *
 * - `GET    ?entity_type=&entity_id=&langcode=` — the translation's messages.
 * - `PUT` — the translation's messages, as the caller now holds them: stated
 *   coordinates are stored, unstated ones are dropped.
 * - `DELETE ?entity_type=&entity_id=&langcode=` — drops them all.
 *
 * One surface for every caller — a browser and a server alike. Who reaches it
 * is {@see \Drupal\inline_comment\Access\InlineCommentApiAccess}.
 *
 * Each message names its own author, and the endpoint takes the caller at its
 * word: a conversation is delivered by whoever witnessed it, which is not the
 * person who said any given line. What keeps that honest is who may call at
 * all — the permission and the subject's update access — plus the author
 * having to be a real account, which the entity's own reference constraint
 * decides.
 */
final class InlineCommentApiController implements ContainerInjectionInterface {

  public function __construct(
    private readonly InlineCommentManager $comments,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self($container->get('inline_comment.manager'));
  }

  /**
   * The entity translation's messages, oldest first.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   *
   * @return \Symfony\Component\HttpFoundation\JsonResponse
   *   The stored messages.
   */
  public function read(Request $request): JsonResponse {
    $subject = $this->comments->subject($request);
    return new JsonResponse($this->describe($subject) + [
      'messages' => $this->comments->messages($subject),
    ]);
  }

  /**
   * Makes the translation's stored messages the ones the request states.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   *
   * @return \Symfony\Component\HttpFoundation\JsonResponse
   *   How many messages this call added and removed.
   */
  public function put(Request $request): JsonResponse {
    $subject = $this->comments->subject($request);
    $messages = $this->messagesFrom($this->comments->body($request));
    return new JsonResponse($this->describe($subject) + $this->comments->put($subject, $messages));
  }

  /**
   * Drops every message about the entity translation.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   *
   * @return \Symfony\Component\HttpFoundation\JsonResponse
   *   How many messages were dropped.
   */
  public function delete(Request $request): JsonResponse {
    $subject = $this->comments->subject($request);
    return new JsonResponse($this->describe($subject) + [
      'dropped' => $this->comments->deleteTranslation($subject),
    ]);
  }

  /**
   * Which translation a response is about.
   *
   * @param \Drupal\Core\Entity\EntityInterface $subject
   *   The commented entity.
   *
   * @return array
   *   The coordinates every answer opens with.
   */
  private function describe(EntityInterface $subject): array {
    return [
      'entity_type' => $subject->getEntityTypeId(),
      'entity_id' => (string) $subject->id(),
      'langcode' => $subject->language()->getId(),
    ];
  }

  /**
   * The messages a PUT states, each with the author it is filed under.
   *
   * Shape only — what makes a message storable is the entity's own validation,
   * which runs per message so one unstorable member cannot hold the rest of
   * the conversation hostage. A message naming nobody is dropped here rather
   * than filed under the anonymous account.
   *
   * @param array $payload
   *   The decoded body.
   *
   * @return array[]
   *   The messages, as {@see InlineCommentManager::put()} takes them.
   */
  private function messagesFrom(array $payload): array {
    $messages = [];
    foreach ($payload['messages'] ?? [] as $stated) {
      if (!is_array($stated)) {
        continue;
      }
      $uid = (int) ($stated['uid'] ?? 0);
      if ($uid <= 0) {
        continue;
      }
      $data = $stated['data'] ?? NULL;
      $messages[] = [
        'anchor' => $this->id($stated['anchor'] ?? NULL),
        'thread_id' => $this->id($stated['thread_id'] ?? NULL),
        'msg_id' => $this->id($stated['msg_id'] ?? NULL),
        'uid' => $uid,
        'data' => is_array($data) ? $data : [],
      ];
    }
    return $messages;
  }

  /**
   * One coordinate, as a bounded string.
   *
   * Truncated rather than refused here: an id that is not one is refused by
   * the field's own constraint, which reports why alongside every other reason
   * a message was not storable.
   *
   * @param mixed $stated
   *   The stated coordinate.
   *
   * @return string
   *   The coordinate.
   */
  private function id(mixed $stated): string {
    return mb_substr(is_scalar($stated) ? (string) $stated : '', 0, InlineComment::ID_MAX_LENGTH);
  }

}
