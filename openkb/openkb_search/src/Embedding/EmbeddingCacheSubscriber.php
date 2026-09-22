<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Embedding;

use Drupal\ai\Event\PostGenerateResponseEvent;
use Drupal\ai\Event\PreGenerateResponseEvent;
use Drupal\ai\OperationType\Embeddings\EmbeddingsCollectionInput;
use Drupal\ai\OperationType\Embeddings\EmbeddingsCollectionOutput;
use Drupal\ai\OperationType\Embeddings\EmbeddingsInput;
use Drupal\ai\OperationType\Embeddings\EmbeddingsOutput;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;

/**
 * Answers an embeddings call from the cache, transparently to the caller.
 *
 * Every provider call runs through drupal/ai's ProviderProxy, which returns a
 * forced output from the pre-request event without reaching the provider. So
 * ai_search's strategies and its query-side embedding are cached as they are,
 * with every embeddings setting untouched, and a stored vector is what that
 * provider once answered for that text and model.
 *
 * Both shapes of the call are covered: one text, and the collection a provider
 * that batches is handed — which is what indexing an item of several chunks
 * takes. A forced output is all or nothing, so a collection with one unknown
 * text goes to the provider whole and every vector it answers is stored.
 */
final class EmbeddingCacheSubscriber implements EventSubscriberInterface {

  /**
   * The operation types an embeddings call arrives as.
   *
   * One text and a collection of them are separate operations, and a provider
   * that batches is called on the second — which is what indexing an item of
   * several chunks takes.
   */
  private const OPERATIONS = ['embeddings', 'embeddings_collection'];

  public function __construct(
    private readonly EmbeddingCacheInterface $cache,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    return [
      PreGenerateResponseEvent::EVENT_NAME => 'onPreGenerate',
      PostGenerateResponseEvent::EVENT_NAME => 'onPostGenerate',
    ];
  }

  /**
   * Forces the cached vectors as the response when every text is known.
   */
  public function onPreGenerate(PreGenerateResponseEvent $event): void {
    $texts = $this->texts($event->getOperationType(), $event->getInput());
    if ($texts === NULL) {
      return;
    }
    $provider = $event->getProviderId();
    $model = $event->getModelId();
    $dimensions = $this->dimensions($event->getConfiguration());
    $vectors = [];
    foreach ($texts as $text) {
      $vector = $this->cache->get($provider, $model, $text, $dimensions);
      if ($vector === NULL) {
        // A forced output is all or nothing, so the whole call is a miss.
        $this->cache->record(0, count($texts));
        return;
      }
      $vectors[] = $vector;
    }
    $this->cache->record(count($texts), 0);
    $event->setForcedOutputObject($this->output($event->getInput(), $vectors));
  }

  /**
   * Stores what the provider answered.
   */
  public function onPostGenerate(PostGenerateResponseEvent $event): void {
    $texts = $this->texts($event->getOperationType(), $event->getInput());
    $output = $event->getOutput();
    if ($texts === NULL || !$output instanceof EmbeddingsOutput) {
      return;
    }
    $provider = $event->getProviderId();
    $model = $event->getModelId();
    $dimensions = $this->dimensions($event->getConfiguration());
    $vectors = $output instanceof EmbeddingsCollectionOutput ? $output->getNormalized() : [$output->getNormalized()];
    foreach (array_values($texts) as $key => $text) {
      if (is_array($vectors[$key] ?? NULL)) {
        $this->cache->set($provider, $model, $text, $dimensions, $vectors[$key]);
      }
    }
  }

  /**
   * The output shape the call expects: one vector, or one per text.
   *
   * @param mixed $input
   *   The input the call was made with.
   * @param list<list<float>> $vectors
   *   The cached vectors, in input order.
   */
  private function output(mixed $input, array $vectors): EmbeddingsOutput {
    $metadata = ['openkb_search' => 'cached'];
    return $input instanceof EmbeddingsCollectionInput
      ? new EmbeddingsCollectionOutput($vectors, $metadata, [])
      : new EmbeddingsOutput($vectors[0], $metadata, []);
  }

  /**
   * The dimension the call asked the model for, 0 when it named none.
   *
   * @param array<string, mixed> $configuration
   *   The request configuration.
   */
  private function dimensions(array $configuration): int {
    return (int) ($configuration['dimensions'] ?? 0);
  }

  /**
   * The texts an embeddings call is about, or NULL for any other call.
   *
   * An image input has no text to key on and is passed through, as is a
   * collection naming none.
   *
   * @return list<string>|null
   *   The texts, in the order the call carries them.
   */
  private function texts(string $operationType, mixed $input): ?array {
    if (!in_array($operationType, self::OPERATIONS, TRUE)) {
      return NULL;
    }
    if ($input instanceof EmbeddingsCollectionInput) {
      $prompts = array_values($input->getPrompts());
      return $prompts === [] ? NULL : $prompts;
    }
    if ($input instanceof EmbeddingsInput) {
      return $input->getImage() === NULL ? [$input->getPrompt()] : NULL;
    }
    return is_string($input) ? [$input] : NULL;
  }

}
