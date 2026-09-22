<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_search\Embedding\EmbeddingCacheInterface;

/**
 * A cached vector answers an embeddings call before the provider is reached.
 *
 * @group openkb_search
 */
final class EmbeddingCacheSubscriberTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system', 'user', 'file', 'key', 'token', 'ai', 'ai_test',
    'search_api', 'search_api_opensearch', 'openkb_schema', 'openkb_search',
  ];

  /**
   * A cached vector short-circuits the provider, a fresh one is stored.
   */
  public function testCachedVectorShortCircuitsTheProvider(): void {
    $this->installConfig(['ai']);
    $cache = $this->container->get(EmbeddingCacheInterface::class);
    /** @var \Drupal\ai\AiProviderPluginManager $providers */
    $providers = $this->container->get('ai.provider');
    $echo = $providers->createInstance('echoai');

    $cache->set('echoai', 'echo-model', 'Release checklist', 0, [0.25, 0.5]);
    $this->assertSame([0.25, 0.5], $echo->embeddings('Release checklist', 'echo-model')->getNormalized());

    $fresh = $echo->embeddings('Unknown text', 'echo-model')->getNormalized();
    $this->assertSame(array_values($fresh), $cache->get('echoai', 'echo-model', 'Unknown text', 0));
  }

}
