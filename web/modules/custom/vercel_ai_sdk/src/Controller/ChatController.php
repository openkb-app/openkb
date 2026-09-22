<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk\Controller;

use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\ai\Plugin\ChatProcessor\ChatProcessorInterface;
use Drupal\ai\PluginManager\ChatProcessorPluginManager;
use Drupal\vercel_ai_sdk\Exception\ChatUnavailableException;
use Drupal\vercel_ai_sdk\Stream\UiMessage;
use Drupal\vercel_ai_sdk\Stream\UiMessageStream;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Streams the Vercel AI SDK UI-message protocol over `text/event-stream`.
 *
 * Endpoint: POST /vercel-ai/chat.
 *
 * Body: {"agentId": "<ai_assistant id>", "messages": [...], "context": {...}?}.
 *
 * `agentId` is the id of an `ai_assistant` config entity owned by a consumer
 * module (this module is the protocol bridge only — it does not ship any
 * assistants). The chunk shape matches what `@ai-sdk/vue` `Chat` +
 * `DefaultChatTransport` expects.
 *
 * The turn itself belongs to a ChatProcessor plugin; this controller reads the
 * body, picks the processor, and frames what it emits.
 */
final class ChatController implements ContainerInjectionInterface {

  /**
   * Constructs the chat controller.
   */
  public function __construct(
    private readonly ChatProcessorPluginManager $processors,
    private readonly AccountInterface $currentUser,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get('plugin.manager.ai.chat_processor'),
      $container->get('current_user'),
    );
  }

  /**
   * Stream the AI-SDK UI-message protocol for a single chat turn.
   */
  public function stream(Request $request): StreamedResponse|JsonResponse {
    $json = json_decode((string) $request->getContent(), TRUE);
    if (!is_array($json)) {
      return new JsonResponse(['error' => 'Invalid JSON body.'], 400);
    }
    $agentId = $json['agentId'] ?? NULL;
    if (!is_string($agentId) || $agentId === '') {
      return new JsonResponse(
        ['error' => 'Missing required field "agentId" (ai_assistant config entity id).'],
        400,
      );
    }

    $processor = $this->processors->createInstance('vercel_ai_sdk', ['assistant_id' => $agentId]);
    if (!$processor->access($this->currentUser)->isAllowed()) {
      return new JsonResponse(['error' => 'You may not use this assistant.'], 403);
    }

    $processor->setInput(UiMessage::toChatInput(
      (array) ($json['messages'] ?? []),
      isset($json['context']) && is_array($json['context']) ? $json['context'] : NULL,
    ));

    // Executed eagerly, while the status is still ours to choose: an
    // unavailable assistant is a server misconfiguration and must read as one,
    // not as a successful stream carrying an apology.
    try {
      $stream = $processor->execute()->getNormalized();
    }
    catch (ChatUnavailableException $e) {
      return new JsonResponse(['error' => $e->getMessage()], 503);
    }
    if (!$stream instanceof UiMessageStream) {
      return new JsonResponse(['error' => 'The chat processor does not speak the UI-message protocol.'], 503);
    }

    $frames = $this->frames($stream, $processor);
    $response = new StreamedResponse(function () use ($frames): void {
      while (ob_get_level() > 0) {
        @ob_end_flush();
      }
      foreach ($frames as $frame) {
        echo $frame;
        @ob_flush();
        flush();
      }
    });

    $response->headers->set('Content-Type', 'text/event-stream');
    $response->headers->set('Cache-Control', 'no-cache');
    $response->headers->set('Connection', 'keep-alive');
    $response->headers->set('X-Vercel-AI-UI-Message-Stream', 'v1');
    $response->headers->set('X-Accel-Buffering', 'no');

    return $response;
  }

  /**
   * The SSE frames of one turn, and the hand-back once it has rendered.
   *
   * @return \Generator<string>
   *   Each yield is one `data: …` frame, ready to echo.
   */
  public function frames(UiMessageStream $stream, ChatProcessorInterface $processor): \Generator {
    $text = '';
    foreach ($stream->doIterate() as $chunk) {
      $text .= $chunk->getText();
      yield 'data: ' . $chunk->getMetadata()[UiMessageStream::PART_KEY] . "\n\n";
    }
    // The contract's hand-back for streamed answers: the processor learns the
    // reply only once it has fully rendered.
    $processor->onStreamComplete($text);
  }

}
