<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite;

use Drupal\Core\Cache\CacheBackendInterface;
use Drupal\Core\Extension\ModuleHandlerInterface;
use Drupal\Core\Plugin\DefaultPluginManager;
use Drupal\ai_rag_cite\Attribute\Retriever;

/**
 * Plugin manager for retrievers.
 */
class RetrieverPluginManager extends DefaultPluginManager {

  /**
   * Constructs the manager.
   *
   * @param \Traversable $namespaces
   *   The namespaces to search.
   * @param \Drupal\Core\Cache\CacheBackendInterface $cache_backend
   *   The cache backend.
   * @param \Drupal\Core\Extension\ModuleHandlerInterface $module_handler
   *   The module handler.
   */
  public function __construct(\Traversable $namespaces, CacheBackendInterface $cache_backend, ModuleHandlerInterface $module_handler) {
    parent::__construct(
      'Plugin/Retriever',
      $namespaces,
      $module_handler,
      RetrieverInterface::class,
      Retriever::class,
    );
    $this->alterInfo('ai_rag_cite_retriever_info');
    $this->setCacheBackend($cache_backend, 'ai_rag_cite_retriever_plugins');
  }

}
