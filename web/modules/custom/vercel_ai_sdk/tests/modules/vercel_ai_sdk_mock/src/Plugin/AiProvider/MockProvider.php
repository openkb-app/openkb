<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_mock\Plugin\AiProvider;

use Drupal\Core\Config\ImmutableConfig;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\ai\Attribute\AiProvider;
use Drupal\ai\Base\AiProviderClientBase;
use Drupal\ai\OperationType\Chat\ChatInput;
use Drupal\ai\OperationType\Chat\ChatInterface;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai\OperationType\Chat\ChatOutput;
use Drupal\vercel_ai_sdk_mock\MockAnswer;
use Drupal\vercel_ai_sdk_mock\MockMode;
use Drupal\vercel_ai_sdk_mock\MockSettings;
use Drupal\vercel_ai_sdk_mock\MockStream;
use Drupal\vercel_ai_sdk\Stream\UiMessage;

/**
 * A chat provider that needs no key, for development and CI.
 *
 * It replaces the model call and nothing else, so an assistant pointed at it
 * still runs its prompt, its tool rounds and `ai_rag_cite`'s retrieval, gate
 * and citation pass. Pointing the assistant at a real provider is how a keyed
 * environment answers for real; there is no mode for that here.
 */
#[AiProvider(
  id: 'mock',
  label: new TranslatableMarkup('Mock (no key)'),
)]
final class MockProvider extends AiProviderClientBase implements ChatInterface {

  /**
   * The one model it offers — the mode decides what a call answers.
   */
  public const MODEL = 'mock-1';

  /**
   * The caller-context key a scripted answer travels under.
   *
   * The bridge strips this key before the context reaches a model's prompt.
   *
   * @see \Drupal\vercel_ai_sdk\Stream\UiMessage::PROVIDER_KEYS
   */
  public const CONTEXT_KEY = 'mock';

  /**
   * Longest pause a request may ask for, in milliseconds.
   *
   * A paced answer holds a PHP worker for its whole length. The setting is the
   * operator's own and uncapped.
   */
  private const MAX_REQUEST_DELAY_MS = 100;

  /**
   * {@inheritdoc}
   */
  public function chat(array|string|ChatInput $input, string $model_id, array $tags = []): ChatOutput {
    $settings = MockSettings::get($this->configFactory);
    $context = $this->context($input);
    $answer = $this->answer($settings, $input, $context);

    $delay = $settings->delayMs;
    $asked = $context[self::CONTEXT_KEY]['delay_ms'] ?? NULL;
    if ($settings->mode === MockMode::Scripted && is_numeric($asked)) {
      $delay = min(max(0, (int) $asked), self::MAX_REQUEST_DELAY_MS);
    }

    // A caller that asked for no stream gets a message; the API Explorer and
    // every non-chat consumer read that one and nothing else.
    $normalized = $this->streamed
      ? MockStream::of($answer, $delay)
      : new ChatMessage('assistant', $answer->text);

    return new ChatOutput($normalized, NULL, $answer->metadata);
  }

  /**
   * The answer for one call.
   *
   * @param \Drupal\vercel_ai_sdk_mock\MockSettings $settings
   *   The site's mock settings.
   * @param array|string|\Drupal\ai\OperationType\Chat\ChatInput $input
   *   What the assistant asked.
   * @param array<string, mixed> $context
   *   The caller context the request carried.
   */
  private function answer(MockSettings $settings, array|string|ChatInput $input, array $context): MockAnswer {
    $prompt = $this->prompt($input);

    $canned = strtr($settings->answer, ['@prompt' => $prompt]);

    return match ($settings->mode) {
      MockMode::Canned => new MockAnswer($canned),
      MockMode::Scripted => $this->scripted($context, $canned),
    };
  }

  /**
   * The answer the caller scripted, on top of the canned one.
   *
   * A caller that scripts nothing gets the canned answer, so a browser run that
   * only wants a turn to look at needs no script at all; one that names only
   * metadata keeps the canned text and adds its data parts.
   *
   * A script that is not an answer is refused rather than dropped: it comes
   * from a test that means to assert on what it asked for.
   *
   * @param array<string, mixed> $context
   *   The caller context.
   * @param string $canned
   *   The canned answer, which the script may leave in place.
   */
  private function scripted(array $context, string $canned): MockAnswer {
    $script = $context[self::CONTEXT_KEY] ?? NULL;
    if ($script === NULL) {
      return new MockAnswer($canned);
    }
    if (!is_array($script) || !is_string($script['text'] ?? '')) {
      throw new \InvalidArgumentException('A scripted answer must be an object with a string "text".');
    }
    return MockAnswer::fromArray($script + ['text' => $canned]);
  }

  /**
   * What the assistant asked: the last user message.
   */
  private function prompt(array|string|ChatInput $input): string {
    if (is_string($input)) {
      return $input;
    }
    $messages = $input instanceof ChatInput ? $input->getMessages() : $input;
    foreach (array_reverse($messages) as $message) {
      if ($message instanceof ChatMessage && $message->getRole() === 'user') {
        return $message->getText();
      }
    }
    return '';
  }

  /**
   * The caller context the request carried, empty when it carried none.
   *
   * @return array<string, mixed>
   *   The context.
   */
  private function context(array|string|ChatInput $input): array {
    if (!$input instanceof ChatInput) {
      return [];
    }
    $context = $input->getRequestMetadataValue(UiMessage::CONTEXT_KEY);
    return is_array($context) ? $context : [];
  }

  /**
   * {@inheritdoc}
   */
  public function getConfig(): ImmutableConfig {
    return $this->configFactory->get(MockSettings::CONFIG);
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
    return [self::MODEL => 'Mock 1'];
  }

  /**
   * {@inheritdoc}
   *
   * No operation type asks whether the provider is set up at all, which a
   * keyless one always is.
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
