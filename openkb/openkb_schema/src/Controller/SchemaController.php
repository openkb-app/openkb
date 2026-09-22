<?php

declare(strict_types=1);

namespace Drupal\openkb_schema\Controller;

use Drupal\Core\Cache\CacheableJsonResponse;
use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\openkb_schema\SchemaBuilder;
use Drupal\openkb_schema\SchemaUnavailableException;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Serves the derived frontmatter JSON Schema.
 *
 * Endpoint: GET /openkb/schema.
 *
 * The response carries the cache tags of the `frontmatter` form display, of
 * every exposed field config and of the body text format, so page/dynamic-page
 * caches invalidate as soon as a site-builder changes the exposure contract or
 * the allowed HTML list.
 */
final class SchemaController implements ContainerInjectionInterface {

  /**
   * Constructs the schema controller.
   */
  public function __construct(
    private readonly SchemaBuilder $schemaBuilder,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self($container->get('openkb_schema.schema_builder'));
  }

  /**
   * Returns the frontmatter JSON Schema.
   */
  public function get(): CacheableJsonResponse {
    $cacheability = new CacheableMetadata();
    try {
      $schema = $this->schemaBuilder->build($cacheability);
    }
    catch (SchemaUnavailableException $e) {
      throw new NotFoundHttpException($e->getMessage(), $e);
    }
    $response = new CacheableJsonResponse($schema);
    $response->addCacheableDependency($cacheability);
    return $response;
  }

}
