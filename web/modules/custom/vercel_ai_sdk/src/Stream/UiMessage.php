<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk\Stream;

use Drupal\ai\OperationType\Chat\ChatInput;
use Drupal\ai\OperationType\Chat\ChatMessage;

/**
 * The Vercel AI SDK UI-message vocabulary, in both directions.
 *
 * Nothing upstream speaks this protocol, so the module owns the translation:
 * request UI messages become a `ChatInput` the ChatProcessor contract accepts,
 * and each part a processor emits becomes one JSON body the controller frames
 * as SSE.
 */
final class UiMessage {

  /**
   * Request metadata key the caller context travels under.
   *
   * The same key `ai_chatbot`'s AI Assistant processor reads, so a processor
   * swap does not move the context.
   */
  public const CONTEXT_KEY = 'contexts';

  /**
   * Context keys that address a provider, not the model.
   *
   * The caller context reaches the provider whole, so one request can tell it
   * something. What the model is shown is prose about the caller, and a
   * provider's own instructions are not that: `mock` carries a scripted answer
   * for `vercel_ai_sdk_mock`, which has no business in a real model's prompt.
   *
   * @see \Drupal\vercel_ai_sdk_mock\Plugin\AiProvider\MockProvider::CONTEXT_KEY
   */
  public const PROVIDER_KEYS = ['mock'];

  /**
   * Context keys that address the retriever, not the model.
   *
   * `scope` is the width the turn is retrieved at, which the retriever applies
   * as a filter over the spaces. It says nothing about what was asked, so to a
   * model it is a bare space name that reads like a topic.
   */
  public const RETRIEVER_KEYS = ['scope'];

  /**
   * The caller context minus the keys addressed to something else.
   *
   * @param array<string, mixed> $context
   *   The caller context.
   *
   * @return array<string, mixed>
   *   What is left for the model.
   */
  public static function modelContext(array $context): array {
    $addressed = array_merge(self::PROVIDER_KEYS, self::RETRIEVER_KEYS);
    return array_diff_key($context, array_flip($addressed));
  }

  /**
   * Builds the chat input for one turn.
   *
   * @param array $messages
   *   AI-SDK UI messages, each `{role, parts: [{type:'text', text}]}` or the
   *   legacy `{role, content: string}` shape. Textless messages are dropped.
   * @param array|null $context
   *   Optional caller context the assistant should reason over.
   */
  public static function toChatInput(array $messages, ?array $context): ChatInput {
    $chatMessages = [];
    foreach ($messages as $message) {
      $text = self::text((array) $message);
      if ($text !== '') {
        $chatMessages[] = new ChatMessage((string) ($message['role'] ?? 'user'), $text);
      }
    }

    $input = new ChatInput($chatMessages);
    if ($context !== NULL) {
      $input->setRequestMetadataValue(self::CONTEXT_KEY, $context);
    }
    return $input;
  }

  /**
   * The text of one UI message.
   *
   * Accepts `parts: [{type:'text', text}]` (v3) or the legacy `content` shape.
   */
  public static function text(array $message): string {
    $text = '';
    foreach ((array) ($message['parts'] ?? []) as $part) {
      if (($part['type'] ?? '') === 'text') {
        $text .= (string) ($part['text'] ?? '');
      }
    }
    if ($text === '' && is_string($message['content'] ?? NULL)) {
      $text = $message['content'];
    }
    return $text;
  }

  /**
   * Encodes one UI-message part as a JSON body, without SSE framing.
   */
  public static function encode(array $part): string {
    return (string) json_encode($part, JSON_UNESCAPED_SLASHES);
  }

}
