<?php

declare(strict_types=1);

namespace Drupal\comark\Plugin\search_api\processor;

use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\path_alias\AliasManagerInterface;
use Drupal\search_api\Attribute\SearchApiProcessor;
use Drupal\search_api\Datasource\DatasourceInterface;
use Drupal\search_api\Item\ItemInterface;
use Drupal\search_api\Processor\ProcessorPluginBase;
use Drupal\search_api\Processor\ProcessorProperty;
use Psr\Container\ContainerInterface;

/**
 * Indexes a page's space-scoped alias as `path`.
 *
 * A hit has to be linkable without loading the page behind it, so the address
 * travels in the indexed row rather than being resolved per hit. It is the
 * relative alias
 * (`/team-wiki/getting-started`) — the one address every surface links by. The
 * entity's canonical URL is not it: on a decoupled site that URL carries the
 * frontend origin, which would bake a deployment's host into the index.
 *
 * The alias manager answers from `/node/<nid>`, so nothing is loaded that
 * indexing has not already loaded.
 */
#[SearchApiProcessor(
  id: 'kb_page_path',
  label: new TranslatableMarkup('Page path'),
  description: new TranslatableMarkup('Adds the page&#039;s space-scoped alias as a `path` field.'),
  stages: [
    'add_properties' => 0,
  ],
)]
final class KbPagePath extends ProcessorPluginBase implements ContainerFactoryPluginInterface {

  public function __construct(
    array $configuration,
    $plugin_id,
    $plugin_definition,
    protected AliasManagerInterface $aliasManager,
  ) {
    parent::__construct($configuration, $plugin_id, $plugin_definition);
  }

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): self {
    return new self($configuration, $plugin_id, $plugin_definition, $container->get('path_alias.manager'));
  }

  /**
   * {@inheritdoc}
   */
  public function getPropertyDefinitions(?DatasourceInterface $datasource = NULL): array {
    if ($datasource !== NULL) {
      return [];
    }
    return [
      'path' => new ProcessorProperty([
        'label' => $this->t('Path'),
        'description' => $this->t('The space-scoped alias a hit links to.'),
        'type' => 'string',
        'processor_id' => $this->getPluginId(),
      ]),
    ];
  }

  /**
   * {@inheritdoc}
   */
  public function addFieldValues(ItemInterface $item): void {
    // The item id is `entity:node/<nid>:<langcode>`.
    if (!preg_match('#/(\d+)#', $item->getId(), $matches)) {
      return;
    }
    $path = $this->aliasManager->getAliasByPath('/node/' . $matches[1]);
    foreach ($item->getFields() as $field) {
      if ($field->getDatasourceId() === NULL && $field->getPropertyPath() === 'path') {
        $field->addValue($path);
      }
    }
  }

}
