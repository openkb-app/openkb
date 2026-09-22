<?php

declare(strict_types=1);

namespace Drupal\comark\Plugin\search_api\processor;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\lupus_decoupled_ce_api\BaseUrlProvider;
use Drupal\node\NodeInterface;
use Drupal\search_api\Attribute\SearchApiProcessor;
use Drupal\search_api\Datasource\DatasourceInterface;
use Drupal\search_api\Item\ItemInterface;
use Drupal\search_api\Processor\ProcessorPluginBase;
use Drupal\search_api\Processor\ProcessorProperty;
use GuzzleHttp\ClientInterface;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;

/**
 * Enriches a kb_page item with comark-derived index fields.
 *
 * One HTTP call per item to the Nuxt sidecar (POST /api/comark/indexable),
 * which parses the markdown with comark and returns `chunks`: one section per
 * entry, as the chunk index holds them.
 *
 * The token target and cap the chunker works to travel with the request, out
 * of `openkb_search.settings`: the embedding strategy that reads the chunks is
 * configured there, so the two cannot drift. Absent — openkb_search is not
 * installed — the sidecar's own defaults answer.
 *
 * Why HTTP and not a PHP parser: comark is JavaScript. The sidecar is the
 * single source of truth for markdown→DOM in this project, so the indexer
 * shares it with the read path instead of forking a second parser in PHP.
 *
 * The sidecar is the decoupled frontend itself, so its origin is the Lupus
 * frontend base URL (`lupus_decoupled_ce_api.settings.frontend_base_url`,
 * overridden by `DRUPAL_FRONTEND_BASE_URL`) — comark carries no origin of its
 * own. That URL has to be reachable from the container that runs indexing.
 */
#[SearchApiProcessor(
  id: 'comark_indexable',
  label: new TranslatableMarkup('Comark indexable (chunks)'),
  description: new TranslatableMarkup("Calls the Nuxt sidecar (POST /api/comark/indexable) to populate the chunks of a kb_page node."),
  stages: [
    'add_properties' => 0,
  ],
)]
final class ComarkIndexable extends ProcessorPluginBase implements ContainerFactoryPluginInterface {

  public function __construct(
    array $configuration,
    $plugin_id,
    $plugin_definition,
    protected ClientInterface $httpClient,
    protected LoggerInterface $logger,
    protected BaseUrlProvider $baseUrlProvider,
    protected ConfigFactoryInterface $configFactory,
  ) {
    parent::__construct($configuration, $plugin_id, $plugin_definition);
  }

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): self {
    /** @var \Drupal\Core\Logger\LoggerChannelFactoryInterface $loggerFactory */
    $loggerFactory = $container->get('logger.factory');
    return new self(
      $configuration,
      $plugin_id,
      $plugin_definition,
      $container->get('http_client'),
      $loggerFactory->get('comark'),
      $container->get('lupus_decoupled_ce_api.base_url_provider'),
      $container->get('config.factory'),
    );
  }

  /**
   * {@inheritdoc}
   */
  public function getPropertyDefinitions(?DatasourceInterface $datasource = NULL): array {
    if ($datasource !== NULL) {
      return [];
    }
    return [
      'chunks' => new ProcessorProperty([
        'label' => $this->t('Chunks'),
        'description' => $this->t('The body as its sections, JSON: block_id, heading_path, part, text, cites and links per chunk. Read by the comark_sections embedding strategy.'),
        'type' => 'string',
        'processor_id' => $this->getPluginId(),
      ]),
      // Declared so the index can carry the field; the value is the chunk
      // row's own, written by the comark_sections embedding strategy.
      'cites' => new ProcessorProperty([
        'label' => $this->t('Cites'),
        'description' => $this->t('The sources a section cites, as "<nid>" and "<nid>#<block>".'),
        'type' => 'string',
        'is_list' => TRUE,
        'processor_id' => $this->getPluginId(),
      ]),
      'links' => new ProcessorProperty([
        'label' => $this->t('Links'),
        'description' => $this->t('The pages a section links to, written the same way.'),
        'type' => 'string',
        'is_list' => TRUE,
        'processor_id' => $this->getPluginId(),
      ]),
    ];
  }

  /**
   * {@inheritdoc}
   */
  public function addFieldValues(ItemInterface $item): void {
    $entity = $item->getOriginalObject()?->getValue();
    if (!$entity instanceof NodeInterface || !$entity->hasField('field_kb_body')) {
      return;
    }
    $markdown = (string) $entity->get('field_kb_body')->value;
    if ($markdown === '') {
      return;
    }

    $frontendBaseUrl = rtrim((string) $this->baseUrlProvider->getFrontendBaseUrl(), '/');
    if ($frontendBaseUrl === '') {
      // Same degraded-but-loud semantics as an unreachable sidecar below:
      // the item still reaches the backend, carrying no section at all.
      $this->logger->error('Comark indexable skipped for node @nid: no frontend base URL. Set it in the Lupus Decoupled settings (lupus_decoupled_ce_api.settings.frontend_base_url). The item is indexed without its chunks, so nothing of what it says is searchable until it is re-indexed.', [
        '@nid' => $entity->id(),
      ]);
      return;
    }

    try {
      $response = $this->httpClient->request('POST', $frontendBaseUrl . '/api/comark/indexable', [
        'json' => ['markdown' => $markdown] + $this->chunkOptions(),
        'timeout' => 10,
        'headers' => ['Accept' => 'application/json'],
      ]);
      $data = json_decode((string) $response->getBody(), TRUE, flags: JSON_THROW_ON_ERROR);
    }
    catch (\Throwable $e) {
      // The item still goes to the backend, with no section to embed:
      // search_api counts it as indexed and will not come back to it. So a
      // failure here silently leaves the page unsearchable — an error, not a
      // warning, and it names the origin it could not reach so a misconfigured
      // sidecar URL is readable off the log line.
      $this->logger->error('Comark indexable fetch failed for node @nid via @url: @msg. The item is indexed without its chunks, so nothing of what it says is searchable until it is re-indexed.', [
        '@nid' => $entity->id(),
        '@url' => $frontendBaseUrl,
        '@msg' => $e->getMessage(),
      ]);
      return;
    }

    $chunks = is_array($data['chunks'] ?? NULL) ? $data['chunks'] : [];

    foreach ($item->getFields() as $field) {
      if ($field->getDatasourceId() !== NULL) {
        continue;
      }
      match ($field->getPropertyPath()) {
        'chunks' => $chunks !== [] ? $field->addValue(Json::encode($chunks)) : NULL,
        default => NULL,
      };
    }
  }

  /**
   * The chunking the sidecar is asked for, empty where nobody configured it.
   *
   * @return array<string, array<string, int>>
   *   The request body's `chunkOptions`, or nothing.
   */
  protected function chunkOptions(): array {
    $chunk = $this->configFactory->get('openkb_search.settings')->get('chunk');
    if (!is_array($chunk)) {
      return [];
    }
    $options = array_filter([
      'targetTokens' => (int) ($chunk['target_tokens'] ?? 0),
      'maxTokens' => (int) ($chunk['max_tokens'] ?? 0),
    ]);
    return $options === [] ? [] : ['chunkOptions' => $options];
  }

}
