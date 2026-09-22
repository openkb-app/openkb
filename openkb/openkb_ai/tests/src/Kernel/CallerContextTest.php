<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_ai\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\ai_assistant_api\Entity\AiAssistant;
use Drupal\ai_rag_cite\EventSubscriber\GroundingSubscriber;
use Drupal\vercel_ai_sdk\Stream\UiMessage;
use Drupal\vercel_ai_sdk\Stream\UiMessageStream;
use Drupal\vercel_ai_sdk_test\Plugin\AiProvider\ScriptedProvider;

/**
 * The turn's caller context travels the whole way it is meant to.
 *
 * The bridge writes it and the grounding reads it under a key each names for
 * itself, because neither module depends on the other. Only this module
 * depends on both, so the two names are held together here: were one to move,
 * every retrieval would silently widen to all spaces with a green suite.
 *
 * @group openkb_ai
 */
final class CallerContextTest extends KernelTestBase {

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
    'ai_rag_cite',
    'search_api',
    'search_api_opensearch',
    'openkb_search',
    'openkb_schema',
    'vercel_ai_sdk',
    'vercel_ai_sdk_test',
    'mcp_server',
    'openkb_ai',
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
    ScriptedProvider::$metadata = [];
  }

  /**
   * The bridge sends the context under the key the grounding reads.
   */
  public function testTheBridgeAndTheGroundingNameOneKey(): void {
    $this->assertSame(UiMessage::CONTEXT_KEY, GroundingSubscriber::CALLER_CONTEXT_KEY);
  }

  /**
   * The page context reaches the prompt, the scope reaches the retriever only.
   *
   * `path` and `space` are page context: where the reader is, which the model
   * reasons over. `scope` is the width retrieval runs at, a filter the model
   * would read as a topic, so it is kept out of the prompt while still riding
   * the same turn's request metadata, which is where the retriever reads it.
   */
  public function testThePageContextReachesThePromptButTheScopeDoesNot(): void {
    $this->createScriptedAssistant();
    $processor = $this->container->get('plugin.manager.ai.chat_processor')
      ->createInstance('vercel_ai_sdk', ['assistant_id' => 'scripted']);
    $context = ['path' => '/handbook/onboarding', 'space' => 'handbook', 'scope' => 'all'];
    $processor->setInput(UiMessage::toChatInput(
      [['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'Where may I write?']]]],
      $context,
    ));

    $this->drain($processor->execute());

    $input = ScriptedProvider::$inputs[0];
    $prompt = $input->getSystemPrompt();
    $this->assertStringContainsString('"path":"/handbook/onboarding"', $prompt);
    $this->assertStringContainsString('"space":"handbook"', $prompt);
    $this->assertStringNotContainsString('"scope"', $prompt);
    // The turn the provider was called with is the one the grounding reads the
    // context off, and it still carries the scope.
    $this->assertSame($context, $input->getRequestMetadataValue(UiMessage::CONTEXT_KEY));
  }

  /**
   * Runs the turn, which is streamed and so only happens while it is read.
   */
  private function drain(mixed $output): void {
    $stream = $output->getNormalized();
    $this->assertInstanceOf(UiMessageStream::class, $stream);
    foreach ($stream->doIterate() as $chunk) {
      // The parts themselves are the bridge's own tests' business.
    }
  }

  /**
   * An assistant answered by the scripted test provider.
   */
  private function createScriptedAssistant(): void {
    AiAssistant::create([
      'id' => 'scripted',
      'label' => 'scripted',
      'status' => TRUE,
      'description' => '',
      'allow_history' => 'none',
      'system_role' => 'assistant',
      'instructions' => 'Be brief.',
      'preprompt_instructions' => '',
      'assistant_message' => '',
      'error_message' => '',
      'specific_error_messages' => [],
      'llm_provider' => 'scripted',
      'llm_model' => 'scripted-1',
      'llm_configuration' => [],
    ])->save();
  }

}
