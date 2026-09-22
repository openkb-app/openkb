<?php

declare(strict_types=1);

namespace Drupal\Tests\vercel_ai_sdk\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai_assistant_api\Entity\AiAssistant;
use Drupal\vercel_ai_sdk\Controller\ChatController;
use Drupal\vercel_ai_sdk\Stream\UiMessage;
use Drupal\vercel_ai_sdk\Stream\UiMessageStream;
use Drupal\vercel_ai_sdk_test\Plugin\AiProvider\ScriptedProvider;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Tests what ChatController answers with, and how it frames a turn.
 *
 * A chat turn that cannot be served must not read as a successful one. Bad
 * input is a 400, an account without the permission a 403, an assistant the
 * site cannot serve a 503, and only a real turn gets the 200 event-stream.
 *
 * @group vercel_ai_sdk
 */
final class ChatControllerTest extends KernelTestBase {

  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected bool $usesSuperUserAccessPolicy = FALSE;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'key',
    'file',
    'ai',
    'ai_assistant_api',
    'vercel_ai_sdk',
    'vercel_ai_sdk_test',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installConfig(['user']);
    ScriptedProvider::$answers = [];
    ScriptedProvider::$inputs = [];
    ScriptedProvider::$callTags = [];
    ScriptedProvider::$metadata = [];
    AiAssistant::create([
      'id' => 'scripted',
      'label' => 'Scripted',
      'description' => '',
      'llm_provider' => 'scripted',
      'llm_model' => 'scripted-1',
      'llm_configuration' => [],
      'instructions' => 'Be brief.',
      'system_role' => 'assistant',
      'allow_history' => 'none',
      'preprompt_instructions' => '',
      'assistant_message' => '',
      'error_message' => '',
      'specific_error_messages' => [],
    ])->save();
    $this->setCurrentUser($this->createUser(['use vercel ai sdk chat']));
  }

  /**
   * An assistant the site cannot serve is a 503, not a 200 with an apology.
   */
  public function testUnavailableAssistantIsServiceUnavailable(): void {
    $response = $this->post([
      'agentId' => 'does-not-exist',
      'messages' => [['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'hi']]]],
    ]);

    self::assertInstanceOf(JsonResponse::class, $response);
    self::assertSame(503, $response->getStatusCode());
    self::assertStringContainsString('does-not-exist', (string) $response->getContent());
  }

  /**
   * A malformed body and a missing agentId stay 400s.
   */
  public function testInvalidRequestsAreBadRequests(): void {
    self::assertSame(400, $this->post('not json')->getStatusCode());
    self::assertSame(400, $this->post(['messages' => []])->getStatusCode());
  }

  /**
   * An account without the permission never reaches a provider.
   */
  public function testWithoutThePermissionItIsForbidden(): void {
    $this->setCurrentUser($this->createUser());

    $response = $this->post([
      'agentId' => 'scripted',
      'messages' => [['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'hi']]]],
    ]);

    self::assertSame(403, $response->getStatusCode());
    self::assertSame([], ScriptedProvider::$inputs);
  }

  /**
   * A real turn is a 200 event-stream the AI SDK recognises.
   */
  public function testTurnIsAnEventStream(): void {
    ScriptedProvider::$answers = [new ChatMessage('assistant', 'Hello.')];

    $response = $this->post([
      'agentId' => 'scripted',
      'messages' => [['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'hi']]]],
    ]);

    self::assertInstanceOf(StreamedResponse::class, $response);
    self::assertSame(200, $response->getStatusCode());
    self::assertSame('text/event-stream', $response->headers->get('Content-Type'));
    self::assertStringContainsString('no-cache', (string) $response->headers->get('Cache-Control'));
    self::assertSame('v1', $response->headers->get('X-Vercel-AI-UI-Message-Stream'));
    self::assertSame('no', $response->headers->get('X-Accel-Buffering'));
  }

  /**
   * Every part is framed as its own SSE event, and the reply is handed back.
   */
  public function testFramingAndStreamCompletion(): void {
    ScriptedProvider::$answers = [new ChatMessage('assistant', 'Hello there.')];

    $processor = $this->container->get('plugin.manager.ai.chat_processor')
      ->createInstance('vercel_ai_sdk', ['assistant_id' => 'scripted']);
    $processor->setInput(UiMessage::toChatInput(
      [['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'hi']]]],
      NULL,
    ));
    $stream = $processor->execute()->getNormalized();
    self::assertInstanceOf(UiMessageStream::class, $stream);

    $frames = iterator_to_array(
      ChatController::create($this->container)->frames($stream, $processor),
      FALSE,
    );

    self::assertNotEmpty($frames);
    foreach ($frames as $frame) {
      self::assertStringStartsWith('data: {', $frame);
      self::assertStringEndsWith("}\n\n", $frame);
    }
    // The processor learned the complete reply once the stream had rendered.
    self::assertSame(
      ['role' => 'assistant', 'message' => 'Hello there.'],
      array_slice($processor->getMessageHistory(), -1)[0],
    );
  }

  /**
   * POSTs a JSON body to the controller.
   */
  private function post(array|string $body): JsonResponse|StreamedResponse {
    $controller = ChatController::create($this->container);
    return $controller->stream(Request::create(
      '/vercel-ai/chat',
      'POST',
      [],
      [],
      [],
      ['CONTENT_TYPE' => 'application/json'],
      is_string($body) ? $body : (string) json_encode($body),
    ));
  }

}
