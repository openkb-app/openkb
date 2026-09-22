<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite_test\Plugin\AiProvider;

use Drupal\Core\Config\ImmutableConfig;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\ai\Attribute\AiProvider;
use Drupal\ai\Base\AiProviderClientBase;
use Drupal\ai\OperationType\Chat\ChatInput;
use Drupal\ai\OperationType\Chat\ChatInterface;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai\OperationType\Chat\ChatOutput;

/**
 * A provider that answers from a script and records what it was asked.
 *
 * Static, because the plugin is wrapped in a ProviderProxy and a test never
 * holds the instance. Reset every property in setUp().
 */
#[AiProvider(
  id: 'scripted',
  label: new TranslatableMarkup('Scripted'),
)]
class ScriptedProvider extends AiProviderClientBase implements ChatInterface {

  /**
   * The answers to give, in order, each one whole or streamed.
   *
   * @var array<int, \Drupal\ai\OperationType\Chat\ChatMessage|\Drupal\ai\OperationType\Chat\StreamedChatMessageIteratorInterface>
   */
  public static array $answers = [];

  /**
   * The system prompt of every call, in order.
   *
   * @var string[]
   */
  public static array $systemPrompts = [];

  /**
   * {@inheritdoc}
   */
  public function chat(array|string|ChatInput $input, string $model_id, array $tags = []): ChatOutput {
    if ($input instanceof ChatInput) {
      self::$systemPrompts[] = $input->getSystemPrompt();
    }
    return new ChatOutput(array_shift(self::$answers) ?? new ChatMessage('assistant', 'Done.'), NULL, []);
  }

  /**
   * {@inheritdoc}
   */
  public function getConfig(): ImmutableConfig {
    return $this->configFactory->get('system.site');
  }

  /**
   * {@inheritdoc}
   */
  public function getApiDefinition(): array {
    return [];
  }

  /**
   * {@inheritdoc}
   */
  public function getModelSettings(string $model_id, array $generalConfig = []): array {
    return $generalConfig;
  }

  /**
   * {@inheritdoc}
   */
  public function getConfiguredModels(?string $operation_type = NULL, array $capabilities = []): array {
    return ['scripted-1' => 'Scripted 1'];
  }

  /**
   * {@inheritdoc}
   */
  public function isUsable(?string $operation_type = NULL, array $capabilities = []): bool {
    return $operation_type === NULL || $operation_type === 'chat';
  }

  /**
   * {@inheritdoc}
   */
  public function getSupportedOperationTypes(): array {
    return ['chat'];
  }

  /**
   * {@inheritdoc}
   */
  public function setAuthentication(mixed $authentication): void {
  }

}
