<?php

declare(strict_types=1);

namespace Drupal\openkb_search;

use Drupal\Core\DependencyInjection\ContainerBuilder;
use Drupal\Core\DependencyInjection\ServiceProviderBase;
use Drupal\openkb_search\Embedding\EmbeddingCacheSubscriber;
use Drupal\openkb_search\EventSubscriber\CollectionMappingSubscriber;
use Drupal\openkb_search\Retrieval\ChunkRetrieval;
use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Symfony\Component\DependencyInjection\Reference;

/**
 * Registers what the chunk index needs once drupal/ai is installed.
 *
 * The lexical index needs no AI module, so `ai` is not a dependency of this
 * module; the subscriber's event classes and the retrieval's provider manager
 * only exist when it is enabled.
 */
final class OpenkbSearchServiceProvider extends ServiceProviderBase {

  /**
   * {@inheritdoc}
   */
  public function register(ContainerBuilder $container): void {
    if (!isset($container->getParameter('container.modules')['ai'])) {
      return;
    }
    $container->register('openkb_search.embedding_cache_subscriber', EmbeddingCacheSubscriber::class)
      ->addArgument(new Reference('openkb_search.embedding_cache'))
      ->addTag('event_subscriber');

    $container->register('openkb_search.chunk_retrieval', ChunkRetrieval::class)
      ->addArgument(new Reference('entity_type.manager'))
      ->addArgument(new Reference('config.factory'))
      ->addArgument(new Reference('ai.provider'))
      ->setPublic(TRUE);
    $container->setAlias(ChunkRetrievalInterface::class, 'openkb_search.chunk_retrieval')
      ->setPublic(TRUE);

    if (isset($container->getParameter('container.modules')['ai_vdb_provider_opensearch'])) {
      $container->register('openkb_search.collection_mapping_subscriber', CollectionMappingSubscriber::class)
        ->addArgument(new Reference('plugin.manager.search_api_opensearch.analyser'))
        ->addTag('event_subscriber');
    }
  }

}
