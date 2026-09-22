<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Kernel;

use Drupal\Core\Cache\Cache;
use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceStorage;

/**
 * How spaces sit in the entity cache.
 *
 * Every authenticated request loads every space for the access policy, so a
 * load that rewrites the cache entry each time turns core's stale-read race
 * (#3474843) from rare into routine.
 *
 * @group openkb_space
 */
final class SpaceEntityCacheTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'options',
    'path_alias',
    'path',
    'views',
    'openkb_space',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
  }

  /**
   * Loading every space reads the entity cache rather than writing over it.
   */
  public function testAllReadsTheEntityCache(): void {
    $space = Space::create(['label' => 'General']);
    $space->save();
    $this->storage()->all();

    // Put a different copy of the space in the cache; a load that reads the
    // cache hands that one back, a load that ignores it overwrites it.
    $cache = $this->container->get('cache.entity');
    $cached = $cache->get($this->cid($space))->data;
    $cached->set('label', 'From the cache');
    $this->cacheSpace($cached);

    $spaces = $this->storage()->all();
    $this->assertSame('From the cache', (string) $spaces[$space->id()]->label());
  }

  /**
   * A save drops the cache entry again once the request is over.
   */
  public function testSaveDropsTheCacheEntryWhenTheRequestEnds(): void {
    $space = Space::create(['label' => 'General']);
    $space->save();

    // A reader that loaded the space just before the save writes its pre-save
    // copy back: core's own reset has already run by then.
    $this->cacheSpace($space);
    $this->assertNotFalse($this->container->get('cache.entity')->get($this->cid($space)));

    $this->container->get('openkb_space.cache_reset')->destruct();
    $this->assertFalse($this->container->get('cache.entity')->get($this->cid($space)));
  }

  /**
   * A space storage with none of this request's loads behind it.
   */
  private function storage(): SpaceStorage {
    $this->container->get('entity.memory_cache')->deleteAll();
    $definition = $this->container->get('entity_type.manager')->getDefinition('openkb_space');
    $storage = SpaceStorage::createInstance($this->container, $definition);
    assert($storage instanceof SpaceStorage);
    return $storage;
  }

  /**
   * The entity cache id core stores a space under.
   */
  private function cid(Space $space): string {
    return 'values:openkb_space:' . $space->id();
  }

  /**
   * Caches a space the way core's entity storage does.
   */
  private function cacheSpace(Space $space): void {
    $this->container->get('cache.entity')->set(
      $this->cid($space),
      $space,
      Cache::PERMANENT,
      ['openkb_space_values', 'entity_field_info'],
    );
  }

}
