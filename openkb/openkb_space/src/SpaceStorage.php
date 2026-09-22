<?php

declare(strict_types=1);

namespace Drupal\openkb_space;

use Drupal\Core\Entity\EntityTypeInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Entity\Sql\SqlContentEntityStorage;
use Drupal\Core\Path\PathValidatorInterface;
use Drupal\path_alias\AliasManagerInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * The space entity type's storage handler, and the repository of spaces.
 */
final class SpaceStorage extends SqlContentEntityStorage implements SpaceStorageInterface {

  /**
   * Resolves a slug to the aliased system path.
   */
  protected AliasManagerInterface $aliasManager;

  /**
   * Turns that system path back into the space it routes to.
   */
  protected PathValidatorInterface $pathValidator;

  /**
   * Loaded spaces, keyed by id.
   *
   * @var \Drupal\openkb_space\SpaceInterface[]|null
   */
  protected ?array $spaces = NULL;

  /**
   * {@inheritdoc}
   */
  public static function createInstance(ContainerInterface $container, EntityTypeInterface $entity_type): static {
    $instance = parent::createInstance($container, $entity_type);
    $instance->aliasManager = $container->get('path_alias.manager');
    $instance->pathValidator = $container->get('path.validator');
    return $instance;
  }

  /**
   * The space storage, typed.
   */
  public static function get(EntityTypeManagerInterface $entity_type_manager): SpaceStorageInterface {
    $storage = $entity_type_manager->getStorage('openkb_space');
    assert($storage instanceof SpaceStorageInterface);
    return $storage;
  }

  /**
   * {@inheritdoc}
   *
   * The ids are queried first so the load can read the entity cache: a
   * `loadMultiple()` without ids skips that cache and writes every space back
   * into it on every request, which is what turns core's stale-read race
   * (#3474843) into a frequent one here.
   */
  public function all(): array {
    if ($this->spaces === NULL) {
      $ids = $this->getQuery()->accessCheck(FALSE)->execute();
      $this->spaces = $this->loadMultiple(array_values($ids));
    }
    return $this->spaces;
  }

  /**
   * {@inheritdoc}
   *
   * A space's slug is its path alias, so this is the alias lookup: `/<slug>`
   * resolves to a system path, and the space is the one that path routes to.
   */
  public function getBySlug(string $slug): ?SpaceInterface {
    if ($slug === '') {
      return NULL;
    }
    $path = $this->aliasManager->getPathByAlias('/' . $slug);
    $url = $this->pathValidator->getUrlIfValidWithoutAccessCheck($path);
    if (!$url || $url->getRouteName() !== 'entity.' . $this->entityTypeId . '.canonical') {
      return NULL;
    }
    return $this->all()[$url->getRouteParameters()[$this->entityTypeId]] ?? NULL;
  }

  /**
   * {@inheritdoc}
   *
   * Core calls this after every save, which is what keeps `all()` fresh when a
   * roster changes mid-request.
   */
  public function resetCache(?array $ids = NULL): void {
    $this->spaces = NULL;
    parent::resetCache($ids);
  }

}
