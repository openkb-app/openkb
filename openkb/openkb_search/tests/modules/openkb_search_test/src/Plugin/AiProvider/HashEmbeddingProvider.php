<?php

declare(strict_types=1);

namespace Drupal\openkb_search_test\Plugin\AiProvider;

use Drupal\Core\Config\ImmutableConfig;
use Drupal\Core\State\StateInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\ai\Attribute\AiProvider;
use Drupal\ai\Base\AiProviderClientBase;
use Drupal\ai\Exception\AiUnsafePromptException;
use Drupal\ai\OperationType\Embeddings\EmbeddingsCollectionInput;
use Drupal\ai\OperationType\Embeddings\EmbeddingsCollectionInterface;
use Drupal\ai\OperationType\Embeddings\EmbeddingsCollectionOutput;
use Drupal\ai\OperationType\Embeddings\EmbeddingsInput;
use Drupal\ai\OperationType\Embeddings\EmbeddingsInterface;
use Drupal\ai\OperationType\Embeddings\EmbeddingsOutput;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Embeddings from the words of the text, so a run needs no API key.
 *
 * Each word picks a dimension and a sign, so two texts rank near each other as
 * far as they share words and no further: a test may not assert that two texts
 * saying the same thing in different words rank near each other. CI falls back
 * here only for a text the exported fixture does not hold.
 */
#[AiProvider(
  id: 'openkb_hash',
  label: new TranslatableMarkup('OpenKB hash embeddings (test)'),
)]
class HashEmbeddingProvider extends AiProviderClientBase implements EmbeddingsInterface, EmbeddingsCollectionInterface {

  /**
   * The dimension the product's index is built for.
   */
  public const DIMENSIONS = 512;

  /**
   * The state key counting how often the provider was reached.
   */
  public const CALLS_STATE_KEY = 'openkb_search_test.embeddings_calls';

  /**
   * The state key the texts of the last call are kept under.
   */
  public const TEXTS_STATE_KEY = 'openkb_search_test.embeddings_texts';

  /**
   * Counts the calls that reached the provider.
   */
  protected StateInterface $state;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition) {
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->state = $container->get('state');
    return $instance;
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
  public function getSupportedOperationTypes(): array {
    return ['embeddings', 'embeddings_collection'];
  }

  /**
   * {@inheritdoc}
   */
  public function isUsable(?string $operation_type = NULL, array $capabilities = []): bool {
    return in_array($operation_type, ['embeddings', 'embeddings_collection'], TRUE);
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
  public function getConfig(): ImmutableConfig {
    return $this->configFactory->get('openkb_search_test.settings');
  }

  /**
   * {@inheritdoc}
   */
  public function setAuthentication(mixed $authentication): void {
    // The provider answers from the text, so there is nothing to authenticate.
  }

  /**
   * {@inheritdoc}
   */
  public function getConfiguredModels(?string $operation_type = NULL, array $capabilities = []): array {
    return ['text-embedding-3-small' => 'Hash of the text'];
  }

  /**
   * {@inheritdoc}
   */
  public function embeddings(string|EmbeddingsInput $input, string $model_id, array $tags = []): EmbeddingsOutput {
    $this->failWhereTheTestAsksFor();
    $text = $input instanceof EmbeddingsInput ? (string) $input->getPrompt() : $input;
    $this->recordCall([$text]);
    $vector = $this->vector($text);
    return new EmbeddingsOutput($vector, $vector, ['model_id' => $model_id]);
  }

  /**
   * {@inheritdoc}
   */
  public function embeddingsCollection(EmbeddingsCollectionInput $input, string $model_id, array $tags = []): EmbeddingsCollectionOutput {
    $this->failWhereTheTestAsksFor();
    $this->recordCall(array_values($input->getPrompts()));
    $vectors = array_map(fn (string $text) => $this->vector($text), array_values($input->getPrompts()));
    return new EmbeddingsCollectionOutput($vectors, $vectors, ['model_id' => $model_id]);
  }

  /**
   * {@inheritdoc}
   */
  public function embeddingsVectorSize(string $model_id): int {
    return $this->dimensions();
  }

  /**
   * {@inheritdoc}
   */
  public function maxEmbeddingsInput($model_id = ''): int {
    return 8191;
  }

  /**
   * Answers like a provider that is down or refusing, while a setting says so.
   *
   * A provider exception is caught and logged by ai_search, so what a caller
   * sees is a short list of vectors rather than an error. A test that means to
   * assert on that path needs a provider it can take down. A moderation guard
   * refusing the prompt is the other failure, and a different answer.
   */
  protected function failWhereTheTestAsksFor(): void {
    if ($this->getConfig()->get('embeddings_refuse')) {
      throw new AiUnsafePromptException('The test asked this provider to refuse the prompt.');
    }
    if ($this->getConfig()->get('embeddings_fail')) {
      throw new \RuntimeException('The test asked this provider to fail.');
    }
  }

  /**
   * Counts the call and keeps its texts.
   *
   * The count is what a test holds the cache to answering by; the texts are
   * what a test reads to see the words a query was embedded as.
   *
   * @param list<string> $texts
   *   The texts the call embedded.
   */
  protected function recordCall(array $texts): void {
    $this->state->set(self::CALLS_STATE_KEY, $this->state->get(self::CALLS_STATE_KEY, 0) + 1);
    $this->state->set(self::TEXTS_STATE_KEY, $texts);
  }

  /**
   * One text's vector: its words, hashed onto the dimensions.
   *
   * Unit length because the index scores on cosine distance, where an
   * unnormalised vector makes a score that cannot be compared across texts.
   * A text without a single word takes the first dimension, so every call
   * answers a vector the store accepts.
   *
   * @return list<float>
   *   The vector.
   */
  protected function vector(string $text): array {
    $dimensions = $this->dimensions();
    $values = array_fill(0, $dimensions, 0.0);
    $length = 0.0;
    foreach ($this->words($text) as $word) {
      $hash = hash('sha256', $word, TRUE);
      $index = ((ord($hash[0]) << 8) | ord($hash[1])) % $dimensions;
      $values[$index] += (ord($hash[2]) & 1) === 1 ? 1.0 : -1.0;
    }
    foreach ($values as $value) {
      $length += $value ** 2;
    }
    if ($length === 0.0) {
      $values[0] = 1.0;
      return $values;
    }
    $length = sqrt($length);
    return array_map(fn (float $value) => $value / $length, $values);
  }

  /**
   * The words of a text, lowercased.
   *
   * @return list<string>
   *   The words.
   */
  private function words(string $text): array {
    return preg_split('/[^\p{L}\p{N}]+/u', mb_strtolower($text), -1, PREG_SPLIT_NO_EMPTY) ?: [];
  }

  /**
   * The dimension asked for, the product's own where the call names none.
   */
  private function dimensions(): int {
    return (int) ($this->configuration['dimensions'] ?? 0) ?: self::DIMENSIONS;
  }

}
