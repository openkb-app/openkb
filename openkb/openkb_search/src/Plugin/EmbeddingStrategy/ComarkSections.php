<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Plugin\EmbeddingStrategy;

use Drupal\Component\Serialization\Json;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\ai_search\Attribute\EmbeddingStrategy;
use Drupal\ai_search\Plugin\EmbeddingStrategy\EmbeddingBase;
use Drupal\search_api\IndexInterface;
use Drupal\search_api\Item\FieldInterface;
use Drupal\search_api\Item\ItemInterface;
use Drupal\search_api\SearchApiException;

/**
 * One row per section, as the sidecar cut them.
 *
 * The chunking is the sidecar's: it parses the markdown for the read page
 * anyway, and only a parsed tree knows where a section ends and which block a
 * citation should land on. So this strategy does no chunking of its own — it
 * reads the `chunks` field the `comark_indexable` processor fills, embeds the
 * index's Contextual Content fields and the heading path in front of each
 * chunk's text, and stores the chunk's own place in the page — and what its
 * blocks cite and link to — beside the index's attributes.
 *
 * It calls the provider plainly. `Embedding\EmbeddingCacheSubscriber` is what
 * keeps a known text from reaching it.
 */
#[EmbeddingStrategy(
  id: 'comark_sections',
  label: new TranslatableMarkup('Comark sections'),
  description: new TranslatableMarkup('One embedding per section of the page, as the comark sidecar cut them: the chunk keeps the block a citation lands on and the headings it sits under. The Main Content field must be the `chunks` property of the comark_indexable processor.'),
)]
final class ComarkSections extends EmbeddingBase {

  /**
   * The chunk keys a row carries beside the index's own attributes.
   */
  private const CHUNK_KEYS = ['block_id', 'heading_path', 'part', 'cites', 'links'];

  /**
   * {@inheritdoc}
   */
  public function getEmbedding(
    string $embedding_engine,
    string $chat_model,
    array $configuration,
    array $fields,
    ItemInterface $search_api_item,
    IndexInterface $index,
  ): array {
    $this->init($embedding_engine, $chat_model, $configuration);
    $this->setDimension($index);
    $chunks = $this->chunks($fields, $index);
    if ($chunks === []) {
      return [];
    }

    $attributes = $this->attributes($fields, $index);
    $context = $this->contextLines($fields, $index, $search_api_item);
    $vectors = $this->getRawEmbeddings(array_map(
      fn (array $chunk) => $this->embeddedText($chunk, $context),
      $chunks,
    ));
    if (count($vectors) < count($chunks)) {
      // The base class logs a provider failure and answers a short list.
      // Returning it would index the page as complete with sections missing;
      // throwing puts the item back in the queue.
      throw new SearchApiException(sprintf(
        'Only %d of %d sections of %s were embedded; the AI provider log holds why.',
        count($vectors),
        count($chunks),
        $search_api_item->getId(),
      ));
    }

    $embeddings = [];
    foreach ($chunks as $key => $chunk) {
      $metadata = $attributes;
      foreach (self::CHUNK_KEYS as $name) {
        $metadata[$name] = $chunk[$name];
      }
      $embeddings[] = [
        'id' => $search_api_item->getId() . ':' . $key,
        'values' => $vectors[$key],
        'metadata' => $this->addContentToMetadata($metadata, $chunk['text'], $index),
      ];
    }
    return $embeddings;
  }

  /**
   * Asks the model for the dimension the collection holds.
   *
   * A strategy is handed its own configuration, never the server's, so nothing
   * else on the way to the provider names that dimension: a model answering
   * several would answer its widest and the write would be rejected.
   *
   * @param \Drupal\search_api\IndexInterface $index
   *   The index being written.
   */
  protected function setDimension(IndexInterface $index): void {
    $engine = $index->getServerInstance()?->getBackendConfig()['embeddings_engine_configuration'] ?? [];
    $dimensions = (int) ($engine['dimensions'] ?? 0);
    if (!empty($engine['set_dimensions']) && $dimensions > 0) {
      $this->embeddingLlm->setConfiguration(['dimensions' => $dimensions]);
    }
  }

  /**
   * What one chunk embeds as: what the page is, where it sits, what it says.
   *
   * A section's own words rarely name the page or the topic it sits under, so
   * the index's Contextual Content lines and the heading path go in front of
   * the text. The path already opens with the page's own heading, so the
   * title line is left out where the two are the same.
   *
   * @param array{heading_path: list<string>, text: string} $chunk
   *   The chunk.
   * @param list<array{line: string, is_title: bool}> $context
   *   The context lines, in field order.
   */
  protected function embeddedText(array $chunk, array $context = []): string {
    $path = $chunk['heading_path'];
    $lines = [];
    foreach ($context as $entry) {
      if ($entry['is_title'] && ($path[0] ?? '') === $entry['line']) {
        continue;
      }
      $lines[] = $entry['line'];
    }
    $lines[] = implode(' > ', $path);
    return implode("\n", [...array_filter($lines), $chunk['text']]);
  }

  /**
   * The row's stored fields: the filterable ones, and the contextual beside.
   *
   * Only what is marked Filterable Attributes reaches ai_search's own
   * metadata. A field that is also embedded is still filtered and shown on a
   * row, so it is stored beside them.
   *
   * @param array $fields
   *   The Search API fields of the item.
   * @param \Drupal\search_api\IndexInterface $index
   *   The index.
   *
   * @return array<string, mixed>
   *   The attributes, keyed by field identifier.
   */
  protected function attributes(array $fields, IndexInterface $index): array {
    $attributes = $this->buildBaseMetadata($fields, $index);
    foreach ($this->fieldsWithOption($fields, $index, 'contextual_content') as $field) {
      $attributes[$field->getFieldIdentifier()] = $this->getValue($field, FALSE);
    }
    return $attributes;
  }

  /**
   * What goes in front of every chunk of this page, one line per field.
   *
   * The page's own title is written bare — it names the page rather than
   * describing it — and every other field as `<label>: <value>`. A field the
   * page leaves empty is left out rather than embedded as a label with
   * nothing after it.
   *
   * @param array $fields
   *   The Search API fields of the item.
   * @param \Drupal\search_api\IndexInterface $index
   *   The index.
   * @param \Drupal\search_api\Item\ItemInterface $item
   *   The item being embedded.
   *
   * @return list<array{line: string, is_title: bool}>
   *   The lines, in field order.
   */
  protected function contextLines(array $fields, IndexInterface $index, ItemInterface $item): array {
    $label_key = $this->labelKey($fields);
    $lines = [];
    foreach ($this->fieldsWithOption($fields, $index, 'contextual_content') as $field) {
      $is_title = $label_key !== '' && $field->getPropertyPath() === $label_key;
      // Read raw: upstream's label conversion writes the first value once
      // per value a multi-value field holds.
      $value = $this->getValue($field, FALSE);
      $value = is_array($value) ? implode(', ', $value) : (string) $value;
      if ($is_title) {
        // The entity's label beats the indexed value, as it does upstream.
        $value = $this->resolveEntityTitle($value, $fields, $item);
      }
      if ($value !== '') {
        $lines[] = [
          'line' => $is_title ? $value : $field->getLabel() . ': ' . $value,
          'is_title' => $is_title,
        ];
      }
    }
    return $lines;
  }

  /**
   * The entity key the datasource's own label is the value of.
   *
   * @param array $fields
   *   The Search API fields of the item.
   *
   * @return string
   *   The key, '' where no field is served by an entity datasource.
   */
  private function labelKey(array $fields): string {
    foreach ($fields as $field) {
      $entity_type_id = $field instanceof FieldInterface ? $field->getDatasource()?->getEntityTypeId() : NULL;
      if ($entity_type_id !== NULL) {
        return (string) $this->entityTypeManager->getDefinition($entity_type_id, FALSE)?->getKey('label');
      }
    }
    return '';
  }

  /**
   * The page's chunks, as the Main Content field carries them.
   *
   * @param array $fields
   *   The Search API fields of the item.
   * @param \Drupal\search_api\IndexInterface $index
   *   The index.
   *
   * @return list<array{block_id: string, heading_path: list<string>, part: int, text: string, cites: list<string>, links: list<string>}>
   *   The chunks, in document order.
   */
  protected function chunks(array $fields, IndexInterface $index): array {
    $json = (string) ($this->mainContentField($fields, $index)?->getValues()[0] ?? '');
    if ($json === '') {
      // An empty body, or a sidecar the processor could not reach — which it
      // logs. Here it is simply a page with no sections.
      return [];
    }
    return array_values(array_filter(array_map(
      fn (mixed $chunk) => $this->chunk($chunk),
      Json::decode($json) ?: [],
    )));
  }

  /**
   * One decoded chunk, or NULL where it carries no text.
   *
   * @return array{block_id: string, heading_path: list<string>, part: int, text: string, cites: list<string>, links: list<string>}|null
   *   The chunk.
   */
  private function chunk(mixed $chunk): ?array {
    if (!is_array($chunk) || !is_string($chunk['text'] ?? NULL) || $chunk['text'] === '') {
      return NULL;
    }
    $path = is_array($chunk['heading_path'] ?? NULL) ? $chunk['heading_path'] : [];
    return [
      'block_id' => (string) ($chunk['block_id'] ?? ''),
      'heading_path' => array_values(array_map('strval', $path)),
      'part' => (int) ($chunk['part'] ?? 0),
      'text' => $chunk['text'],
      'cites' => $this->strings($chunk['cites'] ?? NULL),
      'links' => $this->strings($chunk['links'] ?? NULL),
    ];
  }

  /**
   * One decoded list of strings, empty for anything else.
   *
   * @return list<string>
   *   The values.
   */
  private function strings(mixed $values): array {
    return is_array($values) ? array_values(array_map('strval', $values)) : [];
  }

  /**
   * The index's Main Content field, as its ai_search config names it.
   *
   * @param array $fields
   *   The Search API fields of the item.
   * @param \Drupal\search_api\IndexInterface $index
   *   The index.
   *
   * @return \Drupal\search_api\Item\FieldInterface|null
   *   The field, or NULL where the index names none.
   */
  private function mainContentField(array $fields, IndexInterface $index): ?FieldInterface {
    return $this->fieldsWithOption($fields, $index, 'main_content')[0] ?? NULL;
  }

  /**
   * The item's fields carrying one indexing option, in the index's order.
   *
   * @param array $fields
   *   The Search API fields of the item.
   * @param \Drupal\search_api\IndexInterface $index
   *   The index.
   * @param string $option
   *   The ai_search indexing option.
   *
   * @return list<\Drupal\search_api\Item\FieldInterface>
   *   The fields.
   */
  private function fieldsWithOption(array $fields, IndexInterface $index, string $option): array {
    $options = $this->configFactory->get('ai_search.index.' . $index->id())->get('indexing_options') ?? [];
    $matching = [];
    foreach ($fields as $field) {
      if ($field instanceof FieldInterface && ($options[$field->getFieldIdentifier()]['indexing_option'] ?? '') === $option) {
        $matching[] = $field;
      }
    }
    return $matching;
  }

}
