<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_test\Plugin\AiProvider;

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
 * A chat turn that calls tools is several provider calls, each one shaped by
 * the previous one's result, so a test needs to decide every answer and then
 * read back what the service actually sent. Both are static: the plugin is
 * built by `ai.provider` and wrapped in a ProviderProxy, so a test never holds
 * the instance.
 *
 * Reset both properties in setUp() — a test that inherits the previous one's
 * script is the failure mode this trades for.
 */
#[AiProvider(
  id: 'scripted',
  label: new TranslatableMarkup('Scripted'),
)]
final class ScriptedProvider extends AiProviderClientBase implements ChatInterface {

  /**
   * The answers to give, in order. Exhausted, it answers with a plain message.
   *
   * @var array<int, \Drupal\ai\OperationType\Chat\ChatMessage|\Drupal\ai\OperationType\Chat\StreamedChatMessageIteratorInterface>
   */
  public static array $answers = [];

  /**
   * The ChatInput of every call, in order.
   *
   * @var \Drupal\ai\OperationType\Chat\ChatInput[]
   */
  public static array $inputs = [];

  /**
   * The tags of every call, in order.
   *
   * @var array<int, array<int, string>>
   */
  public static array $callTags = [];

  /**
   * The metadata every answer carries.
   *
   * @var array<string, mixed>
   */
  public static array $metadata = [];

  /**
   * {@inheritdoc}
   */
  public function chat(array|string|ChatInput $input, string $model_id, array $tags = []): ChatOutput {
    if ($input instanceof ChatInput) {
      self::$inputs[] = $input;
    }
    self::$callTags[] = $tags;
    $answer = array_shift(self::$answers) ?? new ChatMessage('assistant', 'Done.');
    return new ChatOutput($answer, NULL, self::$metadata);
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
